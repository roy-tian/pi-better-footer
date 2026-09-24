import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareRateWindows, type RateWindow } from "./headers";

const OPENCODE_GO_PROVIDER = "opencode-go";

type ModelRegistry = Pick<ExtensionContext["modelRegistry"], "getAll" | "getApiKeyForProvider">;

export function isOpenCodeGoProvider(provider: string | undefined): boolean {
	return provider === OPENCODE_GO_PROVIDER;
}

/** Whether Pi's opencode-go models send requests to opencode.ai (not a proxy or override). */
function usesOpenCodeHost(modelRegistry: ModelRegistry): boolean {
	return modelRegistry.getAll().some((model) => {
		if (model.provider !== OPENCODE_GO_PROVIDER) return false;
		try {
			const host = new URL(model.baseUrl).hostname.toLowerCase();
			return host === "opencode.ai" || host.endsWith(".opencode.ai");
		} catch {
			return false;
		}
	});
}

// OpenCode Go: official usage API (primary source)

/** One quota window from the official OpenCode Go usage API. */
interface OpenCodeGoUsageApiWindow {
	status?: string;
	/** Used percent (0..100); remaining = 100 - percent. */
	percent?: number;
	/** ISO-8601 reset timestamp (a now+window placeholder when percent is 0). */
	resetsAt?: string;
}

interface OpenCodeGoUsageApiPayload {
	usage?: {
		rolling?: OpenCodeGoUsageApiWindow;
		weekly?: OpenCodeGoUsageApiWindow;
		monthly?: OpenCodeGoUsageApiWindow;
	};
}

const OPENCODE_GO_USAGE_API_URL = "https://opencode.ai/zen/go/v1/usage";

/**
 * Resolve the OpenCode Go API key — the regular Anthropic-compatible key Pi or
 * the opencode CLI stores when signed in. Reading opencode's own auth store keeps
 * the quota display working across opencode reinstalls/upgrades (the key is
 * rewritten by `opencode auth login`) with no hand-extracted browser cookie.
 *
 * Priority:
 *   1. OPENCODE_GO_API_KEY env var (explicit override).
 *   2. The key Pi itself uses for opencode-go (OPENCODE_API_KEY, /login, or
 *      models.json), while those models still point at opencode.ai: that is
 *      the account Pi bills, and a key for another host is never sent here.
 *   3. `auth.json` in the opencode data dir: $OPENCODE_DATA_DIR (directly or
 *      under opencode/), $XDG_DATA_HOME/opencode/auth.json,
 *      ~/.local/share/opencode/auth.json, macOS ~/Library/Application
 *      Support/opencode/auth.json, Windows %APPDATA% / %LOCALAPPDATA%. The
 *      `opencode-go` entry may be `{ type, key }` (current CLI) or a plain
 *      string (older builds). The file belongs to opencode; it is only ever
 *      read here, never written, and its permissions are opencode's business.
 */
async function readOpenCodeGoApiKey(modelRegistry: ModelRegistry | undefined): Promise<string | undefined> {
	const envKey = process.env.OPENCODE_GO_API_KEY?.trim();
	if (envKey) return envKey;

	if (modelRegistry && usesOpenCodeHost(modelRegistry)) {
		try {
			const piKey = (await modelRegistry.getApiKeyForProvider(OPENCODE_GO_PROVIDER))?.trim();
			if (piKey) return piKey;
		} catch {
			/* no usable Pi credential — fall through to the opencode CLI's */
		}
	}

	const home = homedir();
	const candidates: string[] = [];
	const dataDir = process.env.OPENCODE_DATA_DIR?.trim();
	if (dataDir) {
		candidates.push(join(dataDir, "auth.json"));
		candidates.push(join(dataDir, "opencode", "auth.json"));
	}
	const xdgData = process.env.XDG_DATA_HOME?.trim() || (home ? join(home, ".local", "share") : "");
	if (xdgData) candidates.push(join(xdgData, "opencode", "auth.json"));
	if (home) {
		candidates.push(join(home, ".local", "share", "opencode", "auth.json"));
		if (process.platform === "darwin") {
			candidates.push(join(home, "Library", "Application Support", "opencode", "auth.json"));
		}
	}
	const appdata = process.env.APPDATA?.trim();
	if (appdata) candidates.push(join(appdata, "opencode", "auth.json"));
	const localAppData = process.env.LOCALAPPDATA?.trim();
	if (localAppData) candidates.push(join(localAppData, "opencode", "auth.json"));

	for (const path of candidates) {
		try {
			if (!existsSync(path)) continue;
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
			const entry = parsed["opencode-go"];
			const key =
				typeof entry === "string"
					? entry
					: entry && typeof entry === "object" && !Array.isArray(entry)
						? (entry as { key?: unknown }).key
						: undefined;
			if (typeof key === "string" && key.trim()) return key.trim();
		} catch {
			/* unreadable or malformed auth.json — try the next candidate */
		}
	}
	return undefined;
}

/** Map one official-API window onto the shared RateWindow shape. */
function openCodeGoApiWindow(
	window: OpenCodeGoUsageApiWindow | undefined,
	scope: string,
	windowDurationMins: number,
): RateWindow | undefined {
	if (!window || typeof window.percent !== "number" || !Number.isFinite(window.percent)) {
		return undefined;
	}
	const used = Math.max(0, Math.min(100, window.percent));
	const now = Date.now();
	const resetAt = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : Number.NaN;
	const resetSec = Number.isFinite(resetAt) ? Math.max(0, (resetAt - now) / 1000) : 0;
	return {
		scope,
		percent: 100 - used,
		hasReset: resetSec > 0,
		resetSec,
		capturedAt: now,
		windowDurationMins,
	};
}

/**
 * Query the official OpenCode Go usage endpoint (upstream PR
 * anomalyco/opencode#16513). It returns the same account-wide *used* percents
 * as the workspace dashboard:
 *
 *   {"usage":{"rolling":{"status":"ok","percent":0,
 *     "resetsAt":"2026-08-29T16:58:24.864Z"},"weekly":{...},"monthly":{...}}}
 *
 * rolling ≈ the 5-hour window, weekly ≈ the 7-day window (resets Monday UTC),
 * monthly is the billing-cycle total. 403 means a valid key without a Go
 * subscription (Zen and Go share the workspace key). Returns [] on any miss
 * (no key, 401/403, unexpected shape) so the caller can fall back to the
 * dashboard scrape.
 */
async function readOpenCodeGoRateLimitsViaApi(modelRegistry: ModelRegistry | undefined): Promise<RateWindow[]> {
	const apiKey = await readOpenCodeGoApiKey(modelRegistry);
	if (!apiKey) return [];
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	try {
		const response = await fetch(OPENCODE_GO_USAGE_API_URL, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "identity",
				Authorization: `Bearer ${apiKey}`,
				"User-Agent": "pi-status-footer",
			},
			signal: controller.signal,
		});
		if (!response.ok) return [];
		const payload = (await response.json()) as OpenCodeGoUsageApiPayload;
		const usage = payload?.usage;
		if (!usage || typeof usage !== "object") return [];
		const windows = [
			openCodeGoApiWindow(usage.rolling, "opencode-go:5h", 5 * 60),
			openCodeGoApiWindow(usage.weekly, "opencode-go:7d", 7 * 24 * 60),
			// Billing-cycle total. The 30d windowDurationMins is only a sort key
			// (5h < 7d < 30d).
			openCodeGoApiWindow(usage.monthly, "opencode-go:monthly", 30 * 24 * 60),
		].filter((window): window is RateWindow => window !== undefined);
		windows.sort(compareRateWindows);
		return windows;
	} catch {
		return [];
	} finally {
		clearTimeout(timeout);
	}
}

const OPENCODE_GO_DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace";

/** One quota window parsed from the OpenCode Go dashboard's embedded payload. */
interface OpenCodeGoDashboardWindow {
	usedPercent?: number;
	resetInSec?: number;
}

/**
 * Parse one OpenCode Go dashboard quota window. The dashboard HTML embeds a
 * React payload such as:
 *
 *   rollingUsage:$R[3]={usagePercent:17.5,resetInSec:2345.6}
 *
 * "rolling" ≈ the 5-hour window; "weekly" ≈ the 7-day window; "monthly" is
 * the document-wide limit. The dashboard reports *used* percent; the footer
 * stores the remaining percent to match the Codex/ZAI window semantics.
 */
function parseOpenCodeGoDashboardWindow(
	html: string,
	key: "rolling" | "weekly" | "monthly",
): OpenCodeGoDashboardWindow | undefined {
	// `${key}Usage:$R[<digits>]={...}` — guard the `$`, `[`, `]` metacharacters.
	const objectMatch = new RegExp(`${key}Usage:\\$R\\[\\d+\\]=\\{([^}]*)\\}`).exec(html);
	const body = objectMatch?.[1];
	if (!body) return undefined;
	const usageMatch = /usagePercent:(\d+(?:\.\d+)?)/.exec(body);
	if (!usageMatch) return undefined;
	const usedPercent = Math.max(0, Math.min(100, Number(usageMatch[1])));
	const resetMatch = /resetInSec:(\d+(?:\.\d+)?)/.exec(body);
	const resetInSec = resetMatch ? Math.max(0, Math.round(Number(resetMatch[1]))) : undefined;
	return { usedPercent, resetInSec };
}

interface OpenCodeGoQuotaConfig {
	workspaceId: string;
	authCookie: string;
}

// Relative path of the OpenCode Go quota config file under a config root.
const OPENCODE_GO_QUOTA_CONFIG_REL = ["opencode", "opencode-quota", "opencode-go.json"];

/**
 * Candidate file paths for the OpenCode Go quota config, in priority order:
 * an explicit OPENCODE_GO_QUOTA_CONFIG, then platform-conventional per-user
 * config locations. The first existing, readable file wins.
 */
function openCodeGoQuotaConfigPaths(): string[] {
	const explicit = process.env.OPENCODE_GO_QUOTA_CONFIG?.trim();
	const home = homedir();
	const candidates: string[] = [];
	if (explicit) candidates.push(explicit);
	const xdg = process.env.XDG_CONFIG_HOME?.trim() || (home ? join(home, ".config") : "");
	if (xdg) candidates.push(join(xdg, ...OPENCODE_GO_QUOTA_CONFIG_REL));
	if (home) {
		candidates.push(join(home, ".config", ...OPENCODE_GO_QUOTA_CONFIG_REL));
		if (process.platform === "darwin") {
			candidates.push(join(home, "Library", "Application Support", ...OPENCODE_GO_QUOTA_CONFIG_REL));
		}
	}
	// Windows %APPDATA% / %LOCALAPPDATA%, resolved via env when present.
	const appdata = process.env.APPDATA?.trim();
	if (appdata) candidates.push(join(appdata, ...OPENCODE_GO_QUOTA_CONFIG_REL));
	const localAppData = process.env.LOCALAPPDATA?.trim();
	if (localAppData) candidates.push(join(localAppData, ...OPENCODE_GO_QUOTA_CONFIG_REL));
	return candidates;
}

/**
 * Read and validate a JSON config file holding the OpenCode Go dashboard
 * cookie. On POSIX systems, files readable or writable by group or others are
 * rejected — the auth cookie is a login credential and must not be shared.
 * Returns the parsed { workspaceId, authCookie } on success, undefined on any
 * miss / parse error / permission violation.
 */
function readOpenCodeGoQuotaConfigFile(path: string): OpenCodeGoQuotaConfig | undefined {
	try {
		if (!existsSync(path)) return undefined;
		// Enforce 0600 on POSIX so a leaked cookie file can't be read by others.
		if (process.platform !== "win32") {
			const mode = statSync(path).mode & 0o777;
			if (mode & 0o077) return undefined;
		}
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const obj = parsed as Record<string, unknown>;
		const workspaceId = typeof obj.workspaceId === "string" ? obj.workspaceId.trim() : "";
		const authCookie = typeof obj.authCookie === "string" ? obj.authCookie.trim() : "";
		if (workspaceId && authCookie) return { workspaceId, authCookie };
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the OpenCode Go dashboard credentials — the *fallback* source. The
 * primary source is the official usage API (`/zen/go/v1/usage` + API key, see
 * readOpenCodeGoRateLimitsViaApi); this legacy path is only used when no API
 * key is available. It scrapes the workspace page at
 * opencode.ai/workspace/<id>/go, guarded behind the browser `auth` cookie.
 *
 * Priority:
 *   1. A 0600 JSON config file (OPENCODE_GO_QUOTA_CONFIG, or the conventional
 *      per-user config location). The first existing, valid file wins;
 *      permission-violating files are skipped over, not fatal.
 *   2. The OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE env vars.
 *
 * Example config file (~/.config/opencode/opencode-quota/opencode-go.json,
 * chmod 600):
 *
 *   { "workspaceId": "wrk_...", "authCookie": "Fe26.2*..." }
 *
 * workspaceId is the id in https://opencode.ai/workspace/<id>/go. The cookie is
 * the `auth` value for opencode.ai visible in browser devtools; treat it as a
 * secret and prefer the 0600 file over the env so it never lands in shell
 * history, /proc/environ, or a dotfiles repo.
 */
function getOpenCodeGoQuotaConfig(): OpenCodeGoQuotaConfig | undefined {
	for (const path of openCodeGoQuotaConfigPaths()) {
		const fromFile = readOpenCodeGoQuotaConfigFile(path);
		if (fromFile) return fromFile;
	}
	const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
	const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
	if (workspaceId && authCookie) return { workspaceId, authCookie };
	return undefined;
}

/**
 * Fetch OpenCode Go usage — rolling (5h), weekly (7d) and monthly (total) —
 * reduced to the same rate-limit window shape used by the Codex/ZAI paths.
 *
 * Primary source is the official usage API `GET /zen/go/v1/usage` with an
 * OpenCode API key (see readOpenCodeGoApiKey); the dashboard SSR scrape is kept as a fallback
 * for cookie-only setups. Returns [] when neither source is available or
 * authenticated — callers keep any previously recorded windows in that case.
 */
export async function readOpenCodeGoRateLimits(modelRegistry?: ModelRegistry): Promise<RateWindow[]> {
	const viaApi = await readOpenCodeGoRateLimitsViaApi(modelRegistry);
	if (viaApi.length > 0) return viaApi;
	const config = getOpenCodeGoQuotaConfig();
	if (!config) return [];
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	try {
		const response = await fetch(`${OPENCODE_GO_DASHBOARD_URL_PREFIX}/${encodeURIComponent(config.workspaceId)}/go`, {
			headers: {
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Encoding": "identity",
				Cookie: `auth=${config.authCookie}`,
				"User-Agent": "pi-status-footer",
			},
			signal: controller.signal,
		});
		if (!response.ok) return [];
		const html = await response.text();
		const rolling = parseOpenCodeGoDashboardWindow(html, "rolling");
		const weekly = parseOpenCodeGoDashboardWindow(html, "weekly");
		const monthly = parseOpenCodeGoDashboardWindow(html, "monthly");
		if (!rolling && !weekly && !monthly) return [];

		const now = Date.now();
		const toWindow = (
			w: OpenCodeGoDashboardWindow | undefined,
			scope: string,
			windowDurationMins: number,
		): RateWindow | undefined => {
			if (!w || typeof w.usedPercent !== "number") return undefined;
			const remaining = Math.max(0, Math.min(100, 100 - w.usedPercent));
			const resetSec = typeof w.resetInSec === "number" && w.resetInSec > 0 ? w.resetInSec : 0;
			return {
				scope,
				percent: remaining,
				hasReset: resetSec > 0,
				resetSec,
				capturedAt: now,
				windowDurationMins,
			};
		};

		// Every window shows a live time-until-reset countdown, so the footer
		// reads as "4h NN% · 6d NN% · 4d NN%".
		const windows = [
			toWindow(rolling, "opencode-go:5h", 5 * 60),
			toWindow(weekly, "opencode-go:7d", 7 * 24 * 60),
			toWindow(monthly, "opencode-go:monthly", 30 * 24 * 60),
		].filter((window): window is RateWindow => window !== undefined);
		windows.sort(compareRateWindows);
		return windows;
	} catch {
		return [];
	} finally {
		clearTimeout(timeout);
	}
}
