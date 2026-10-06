import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { sep } from "node:path";
import { CHATGPT_QUOTA_KEY, CHATGPT_USAGE_URL, COPILOT_PROVIDER, hasRecentChatGPTLimit } from "../quota/quotas";
import type { FooterState } from "./state";
import { summarizeSessionUsage } from "./session-stats";

export interface FooterTheme {
	readonly name?: string;
	readonly appearance?: "dark" | "light";
	fg(color: string, text: string): string;
	bold(text: string): string;
}

function isLightFooterTheme(theme: FooterTheme | undefined): boolean {
	if (theme?.appearance !== undefined) return theme.appearance === "light";
	const name = theme?.name?.toLowerCase() ?? "";
	if (name.includes("light")) return true;
	if (name.includes("dark")) return false;
	const background = Number(process.env.COLORFGBG?.split(";").at(-1));
	return Number.isFinite(background) && background >= 7;
}

/**
 * Warning colour for quota, context and speed. Built-in light's `warning`
 * (#9a7326) falls below 4.5:1 on white, so light themes use the darker
 * `syntaxFunction` token (#795E26, 6.1:1) instead of a hard-coded RGB value.
 */
function footerWarningColor(theme: FooterTheme | undefined): string {
	return isLightFooterTheme(theme) ? "syntaxFunction" : "warning";
}

/**
 * Colour the reset-countdown label ("4h", "4d") so it reads as distinct from
 * the remaining-percent beside it. Built-in dark already separates dim (#666)
 * from muted (#808); built-in light maps both dim (#767) and muted (#6c) to
 * near-identical greys, so the teal accent takes over there.
 */
function styleResetLabel(theme: FooterTheme | undefined, text: string): string {
	if (!theme) return text;
	return isLightFooterTheme(theme) ? theme.fg("accent", text) : theme.fg("dim", text);
}

/** Throughput uses theme muted → warning → error by displayed speed; the unit stays dim. */
function styleTokenSpeed(theme: FooterTheme | undefined, value: number, estimated: boolean): string {
	const label = `${estimated ? "~" : ""}${value}`;
	if (!theme) return `${label}t/s`;
	const color = value < 50 ? "muted" : value < 150 ? footerWarningColor(theme) : "error";
	return `${theme.fg(color, label)}${theme.fg("dim", "t/s")}`;
}

function styleCopilotCredits(theme: FooterTheme | undefined, credits: string): string {
	const match = /^(\d+)\/(\d+)$/.exec(credits);
	if (!match || !theme) return credits;
	const remaining = Number(match[1]);
	const total = Number(match[2]);
	// Invalid or unknown capacity must not masquerade as an exhausted quota.
	const value =
		Number.isFinite(remaining) && Number.isFinite(total) && total > 0
			? pctColor(theme, (remaining / total) * 100, match[1])
			: theme.fg("muted", match[1]);
	return `${value}/${theme.fg("dim", match[2])}`;
}

function styleSessionStat(theme: FooterTheme | undefined, text: string): string {
	return theme ? theme.fg("muted", text) : text;
}

/** pi's compact token formatter for footer session statistics. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** nf-fa-hammer (Nerd Fonts, U+EEFF): the Z.AI monthly tool-invocation quota. */
const TOOL_QUOTA_ICON = "\uEEFF";

/** Compact time-until-reset using only the largest unit: 6d / 1h / 30m. */
function fmtReset(sec: number): string {
	if (sec <= 0) return "0s";
	const total = Math.floor(sec);
	const d = Math.floor(total / 86400);
	const h = Math.floor(total / 3600);
	const m = Math.floor(total / 60);
	if (d >= 1) return `${d}d`;
	if (h >= 1) return `${h}h`;
	if (m >= 1) return `${m}m`;
	return `${total}s`;
}

function sanitize(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** Left + right aligned on one line, padding in the middle. Truncates as needed. */
function joinLR(width: number, left: string, right: string, minGap = 1): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + minGap + rw <= width) {
		return left + " ".repeat(Math.max(minGap, width - lw - rw)) + right;
	}
	const avail = width - lw - minGap;
	if (avail > 4) return left + " ".repeat(minGap) + truncateToWidth(right, avail, "");
	if (lw >= width) return truncateToWidth(left, width, "");
	return truncateToWidth(`${left} ${right}`, width, "");
}

/**
 * Fit session usage on the left and model/quota information on the right.
 * Narrowing drops the token speed first, then quota windows, then session
 * detail: quota is the footer's main job, the speed only a reading.
 */
function fitSessionLine(
	width: number,
	sessionVariants: string[],
	speed: string | undefined,
	modelSegments: string[],
	sep: string,
): string {
	const minGap = 2;
	const minModelSegments = Math.min(2, modelSegments.length);
	const fits = (left: string, right: string) => visibleWidth(left) + minGap + visibleWidth(right) <= width;
	for (const session of sessionVariants) {
		const allModel = modelSegments.join(sep);
		const withSpeed = speed ? `${session}${sep}${speed}` : undefined;
		if (withSpeed && fits(withSpeed, allModel)) return joinLR(width, withSpeed, allModel, minGap);
		for (let n = modelSegments.length; n >= minModelSegments; n--) {
			const right = modelSegments.slice(0, n).join(sep);
			if (fits(session, right)) return joinLR(width, session, right, minGap);
		}
	}

	// The context-window segment is always present, so the last variant is never empty.
	const essential = modelSegments.slice(0, minModelSegments).join(sep);
	const left = sessionVariants.at(-1) ?? "";
	const right = truncateToWidth(essential, Math.max(0, Math.floor(width * 0.45)), "");
	const leftWidth = Math.max(0, width - visibleWidth(right) - minGap);
	if (leftWidth === 0) return truncateToWidth(left, width, "");
	return joinLR(width, truncateToWidth(left, leftWidth, ""), right, minGap);
}

// ---------------------------------------------------------------------------
type FooterRenderHandle = {
	state: FooterState;
	ctx: ExtensionContext | undefined;
	footerData?: {
		getGitBranch(): string | null;
		getExtensionStatuses(): ReadonlyMap<string, string>;
	};
};

function renderProjectText(H: FooterRenderHandle, width: number, theme: FooterTheme | undefined): string {
	const fg = (color: string, text: string) => (theme ? theme.fg(color, text) : text);
	const dim = (text: string) => fg("dim", text);
	let cwd = H.ctx?.sessionManager.getCwd() ?? "";
	// A trailing separator in HOME would swallow the next one ("~proj"), and a root
	// HOME ("/" in some containers, or a bare drive) would match every path.
	const home = homedir().replace(/[\\/]+$/, "");
	if (home && !/^[A-Za-z]:$/.test(home) && (cwd === home || cwd.startsWith(home + sep))) {
		cwd = `~${cwd.slice(home.length)}`;
	}

	const branch = H.footerData?.getGitBranch() ?? null;
	const projectRef = branch ? `${dim(cwd)} ${fg("accent", "")} ${fg("accent", branch)}` : dim(cwd);
	const gitChanges = H.state.gitDirty
		? ` ${dim("·")} ${fg("success", `+${H.state.gitAdded}`)} ${fg("error", `-${H.state.gitRemoved}`)}`
		: "";
	const version = H.state.projectVersion
		? ` ${dim("·")} ${dim("v")}${fg("muted", H.state.projectVersion.slice(1))}`
		: "";
	return truncateToWidth(`${projectRef}${version}${gitChanges}`, width, "");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pctColor(theme: FooterTheme | undefined, percent: number, text: string): string {
	const fallback = (c: string, t: string) => (theme ? theme.fg(c, t) : t);
	if (percent <= 10) return fallback("error", text);
	if (percent <= 30) return fallback(footerWarningColor(theme), text);
	return fallback("muted", text);
}

export function renderFooter(H: FooterRenderHandle & { theme?: FooterTheme }, width: number): string[] {
	const { state, ctx, theme, footerData } = H;
	const fg = (c: string, t: string) => (theme ? theme.fg(c, t) : t);
	const dim = (t: string) => fg("dim", t);
	const sep = ` ${dim("·")} `;

	// -- Second line right: model and subscription information ---------------
	const modelSegments: string[] = [];
	// Provider and model share a compact "provider/model" segment, distinguished
	// by color instead of the looser " · " separator used between other segments.
	const providerModel = `${fg("accent", state.currentModelProvider ?? "no-provider")}/${dim(state.currentModelId ?? "no-model")}`;
	if (state.currentModelReasoning) {
		modelSegments.push(`${providerModel} ${fg("accent", state.thinkingLevel || "off")}`);
	} else {
		modelSegments.push(providerModel);
	}

	if (state.currentQuotaKey === CHATGPT_QUOTA_KEY) {
		const limited = hasRecentChatGPTLimit(state.providerQuotas.get(CHATGPT_QUOTA_KEY)?.chatgptLimitAt);
		const label = fg(limited ? "error" : "dim", limited ? "ChatGPT limit" : "ChatGPT");
		// The direct-token flow exposes no numeric subscription balance. Link to
		// the official usage page instead of borrowing another Codex CLI account.
		modelSegments.push(`\x1b]8;;${CHATGPT_USAGE_URL}\x1b\\${label}\x1b]8;;\x1b\\`);
	}

	if (state.currentModelProvider === COPILOT_PROVIDER && state.copilotCredits) {
		modelSegments.push(styleCopilotCredits(theme, state.copilotCredits));
	}

	const speedSegment =
		state.tokenSpeed != null && state.tokenSpeed > 0
			? styleTokenSpeed(theme, Math.round(state.tokenSpeed), state.tokenSpeedEstimated)
			: undefined;

	const activeWindows = state.rateWindows.filter(
		(w) => !w.hasReset || w.resetSec - (Date.now() - w.capturedAt) / 1000 > 0,
	);
	for (const w of activeWindows.slice(0, 3)) {
		const pct = pctColor(theme, w.percent, `${Math.round(w.percent)}%`);
		let label: string | undefined;
		if (w.hasReset) {
			label = styleResetLabel(theme, fmtReset(Math.max(0, w.resetSec - (Date.now() - w.capturedAt) / 1000)));
		} else if (w.scope === "zai:monthly") {
			// The monthly Z.AI window meters tool invocations (search, web reader,
			// zread), not model usage: a hammer icon (nf-fa-hammer, U+EEFF) marks it
			// as such, colored like the 5h/7d countdown labels beside it.
			label = styleResetLabel(theme, TOOL_QUOTA_ICON);
		}
		modelSegments.push(label ? `${label} ${pct}` : pct);
	}

	// Extension statuses occupy the otherwise free right side of the project line.
	let status = "";
	const statuses = footerData?.getExtensionStatuses();
	if (statuses && statuses.size > 0) {
		status = dim(
			Array.from(statuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitize(text))
				.filter(Boolean)
				.join("  "),
		);
	}

	// -- Second line left: session statistics, context window, then speed ----
	const { totals, latestHit } = summarizeSessionUsage(ctx?.sessionManager);
	const usage = ctx?.getContextUsage();
	const contextTokens = usage?.tokens ?? null;
	const contextPercent = usage?.percent ?? 0;
	const contextWindow = usage?.contextWindow ?? ctx?.model?.contextWindow ?? 0;
	const contextText = contextTokens === null ? "?" : formatTokens(contextTokens);
	// Context warnings apply only to context usage, not unrelated session labels.
	const contextColor = contextPercent > 90 ? "error" : contextPercent > 70 ? footerWarningColor(theme) : "muted";

	const inputPart =
		totals.input > 0 ? `${fg("accent", "↑")}${styleSessionStat(theme, formatTokens(totals.input))}` : undefined;
	// Match pi's native counters: separate cache reads and writes, hiding zero values.
	const cacheReadPart =
		totals.cacheRead > 0 ? `${fg("accent", "R")}${styleSessionStat(theme, formatTokens(totals.cacheRead))}` : undefined;
	const cacheWritePart =
		totals.cacheWrite > 0
			? `${fg("accent", "W")}${styleSessionStat(theme, formatTokens(totals.cacheWrite))}`
			: undefined;
	const contextPart = fg(contextColor, contextText);
	const outputPart =
		totals.output > 0 ? `${fg("accent", "↓")}${styleSessionStat(theme, formatTokens(totals.output))}` : undefined;
	const hitPart =
		totals.cacheRead > 0 && latestHit !== undefined
			? `${fg("accent", "CH")}${styleSessionStat(theme, `${latestHit.toFixed(1)}%`)}`
			: undefined;
	// Session cost ("$0.123"), pi's own footer format: the $ shares the accent
	// color of the ↑/↓/CH markers, the amount stays muted. Only models with
	// cost rates report one; subscription-backed providers show quota windows
	// instead, so their cost stays hidden rather than reading "$0.000 (sub)".
	const costPart =
		totals.cost > 0 ? `${fg("accent", "$")}${styleSessionStat(theme, totals.cost.toFixed(3))}` : undefined;
	// Context-window segment: current context tokens / window total ("66k/1.0M").
	// The usage number is muted (warning/error past its thresholds); the fixed
	// total stays dim, mirroring the cwd/branch split of the project line.
	// Always show the capacity, even with zero or temporarily unknown usage.
	const windowPart = `${contextPart}/${dim(contextWindow > 0 ? formatTokens(contextWindow) : "?")}`;

	const quantity = [inputPart, outputPart, cacheReadPart, cacheWritePart, hitPart].filter(Boolean).join(" ");
	const compactQuantity = [inputPart, outputPart, cacheReadPart, cacheWritePart].filter(Boolean).join(" ");
	// Separate cost and context from the space-delimited token counters; the
	// speed is appended by fitSessionLine only while every quota window fits.
	const sessionVariants = Array.from(
		new Set([
			[quantity, costPart, windowPart].filter(Boolean).join(sep),
			[compactQuantity, costPart, windowPart].filter(Boolean).join(sep),
			windowPart,
		]),
	);

	const project = renderProjectText(H, width, theme);
	const projectLine = status ? joinLR(width, project, status, 2) : project;
	const sessionLine = fitSessionLine(width, sessionVariants, speedSegment, modelSegments, sep);
	return [truncateToWidth(projectLine, width, ""), truncateToWidth(sessionLine, width, "")];
}
