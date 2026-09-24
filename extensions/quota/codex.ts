import { spawn } from "node:child_process";
import { compareRateWindows, type RateWindow } from "./headers";

interface CodexRateLimitWindowPayload {
	usedPercent?: number;
	windowDurationMins?: number | null;
	resetsAt?: number | null;
}

interface CodexRateLimitSnapshotPayload {
	primary?: CodexRateLimitWindowPayload | null;
	secondary?: CodexRateLimitWindowPayload | null;
	individualLimit?: {
		remainingPercent?: number;
		resetsAt?: number;
	} | null;
	credits?: { hasCredits?: boolean; unlimited?: boolean } | null;
}

/**
 * Read ChatGPT subscription quota from the locally authenticated Codex CLI.
 * This calls only the read-only app-server RPC and never starts a model turn.
 */
export function readCodexRateLimits(): Promise<RateWindow[]> {
	return new Promise((resolve) => {
		const child = spawn("codex", ["app-server", "--stdio"], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		let settled = false;
		let buffer = "";
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const finish = (windows: RateWindow[]) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			try {
				child.stdin.end();
			} catch {
				/* ignore */
			}
			try {
				child.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			resolve(windows);
		};

		const parseSnapshot = (
			snapshot: CodexRateLimitSnapshotPayload,
			ordinaryUsageAllowed: boolean | null | undefined,
		): RateWindow[] => {
			const now = Date.now();
			const windows: RateWindow[] = [];
			// When the backend still allows usage (or credits pay for it past the plan
			// limits), a used-up plan window is displayed but does not make the models
			// unusable. The individual spend limit caps credit use, so it stays binding.
			const stillUsable =
				ordinaryUsageAllowed === true || snapshot.credits?.unlimited === true || snapshot.credits?.hasCredits === true;
			const addWindow = (name: string, value: CodexRateLimitWindowPayload | null | undefined) => {
				if (!value || typeof value.usedPercent !== "number") return;
				const resetsAt = typeof value.resetsAt === "number" ? value.resetsAt * 1000 : 0;
				const resetSec = resetsAt > now ? (resetsAt - now) / 1000 : 0;
				const duration = typeof value.windowDurationMins === "number" ? value.windowDurationMins : undefined;
				windows.push({
					scope: `codex:${name}`,
					percent: Math.max(0, Math.min(100, 100 - value.usedPercent)),
					hasReset: resetSec > 0,
					resetSec,
					capturedAt: now,
					windowDurationMins: duration,
					...(stillUsable ? { advisory: true } : {}),
				});
			};
			addWindow("primary", snapshot.primary);
			addWindow("secondary", snapshot.secondary);

			// Codex reports spend/individual quota as remaining percent. It is the
			// total-usage segment, intentionally shown without a reset countdown.
			if (typeof snapshot.individualLimit?.remainingPercent === "number") {
				windows.push({
					scope: "codex:individual",
					percent: Math.max(0, Math.min(100, snapshot.individualLimit.remainingPercent)),
					hasReset: false,
					resetSec: 0,
					capturedAt: now,
				});
			}
			windows.sort(compareRateWindows);
			return windows;
		};

		child.on("error", () => finish([]));
		child.on("close", () => finish([]));
		// A codex that exits before reading stdin (e.g. an older CLI rejecting the
		// arguments) makes the writes below fail with EPIPE; unhandled, that error
		// would reach Pi's uncaughtException handler and exit Pi.
		child.stdin.on("error", () => finish([]));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line) continue;
				try {
					const response = JSON.parse(line) as {
						id?: number;
						result?: { rateLimits?: CodexRateLimitSnapshotPayload; ordinaryUsageAllowed?: boolean | null };
					};
					if (response.id !== 2) continue;
					const snapshot = response.result?.rateLimits;
					finish(snapshot ? parseSnapshot(snapshot, response.result?.ordinaryUsageAllowed) : []);
				} catch {
					/* ignore notifications and malformed lines */
				}
			}
		});

		timeout = setTimeout(() => finish([]), 10_000);
		try {
			child.stdin.write(
				`${JSON.stringify({
					method: "initialize",
					id: 1,
					params: {
						clientInfo: {
							name: "pi-status-footer",
							title: "Pi Status Footer",
							version: "1.0.0",
						},
					},
				})}\n`,
			);
			child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
			child.stdin.write(
				`${JSON.stringify({
					method: "account/rateLimits/read",
					id: 2,
					params: {},
				})}\n`,
			);
		} catch {
			finish([]);
		}
	});
}

/**
 * Parse Codex subscription usage from `x-codex-*` response headers into the same
 * RateWindow shape the app-server RPC produces, so after_provider_response can
 * keep the footer fresh between RPC backbone rounds without spawning a process.
 *
 * Header fields (aligned with the maintained @mtrojnar/pi-usage parser):
 *   x-codex-{primary,secondary}-used-percent
 *   x-codex-{primary,secondary}-window-minutes
 *   x-codex-{primary,secondary}-reset-after-seconds | -reset-at (epoch sec)
 *
 * Scopes match the RPC: `codex:primary`, `codex:secondary`. The
 * `codex:individual` spend-limit window has no header equivalent and is left
 * untouched here. When a header gives used-percent but omits reset-at /
 * reset-after, the previous window's capturedAt and resetSec are preserved so
 * its countdown keeps ticking down smoothly. Returns [] when no x-codex-* headers
 * are present, leaving the cached snapshot intact. Note that over the default
 * Codex transport (`auto` → WebSocket) pi-ai never invokes the onResponse
 * callback, so after_provider_response does not fire at all and this parser
 * never runs; the ~60s app-server RPC poll (refreshCodexRateLimits) carries
 * the real-time load in that case. This header path only helps for the SSE
 * transport / SSE fallback.
 */
export function parseCodexUsageHeaders(
	headers: Record<string, string>,
	status: number,
	previous: RateWindow[],
): RateWindow[] {
	const looksLikeCodex = status === 429 || Object.keys(headers).some((k) => k.toLowerCase().startsWith("x-codex-"));
	if (!looksLikeCodex) return [];

	const now = Date.now();
	const out: RateWindow[] = [];
	const headerNum = (name: string): number | undefined => {
		const lower = name.toLowerCase();
		for (const [k, v] of Object.entries(headers)) {
			if (k.toLowerCase() !== lower) continue;
			if (!v || v.trim() === "") return undefined;
			const n = Number(v.trim());
			return Number.isFinite(n) ? n : undefined;
		}
		return undefined;
	};
	const clampP = (n: number): number => Math.max(0, Math.min(100, n));

	const addSlot = (slot: "primary" | "secondary"): void => {
		const usedPct = headerNum(`x-codex-${slot}-used-percent`);
		const windowMins = headerNum(`x-codex-${slot}-window-minutes`);
		const resetAfterSec = headerNum(`x-codex-${slot}-reset-after-seconds`);
		const resetAtSec = headerNum(`x-codex-${slot}-reset-at`);
		if (usedPct === undefined && windowMins === undefined && resetAfterSec === undefined && resetAtSec === undefined) {
			return;
		}
		const prev = previous.find((w) => w.scope === `codex:${slot}`);
		const remaining = usedPct !== undefined ? clampP(100 - usedPct) : (prev?.percent ?? 100);
		const hasResetAt = resetAtSec !== undefined && resetAtSec > 0;
		const hasResetAfter = resetAfterSec !== undefined && resetAfterSec > 0;
		let resetSec: number;
		let capturedAt: number;
		if (hasResetAt) {
			resetSec = Math.max(0, resetAtSec - Math.floor(now / 1000));
			capturedAt = now;
		} else if (hasResetAfter) {
			resetSec = resetAfterSec;
			capturedAt = now;
		} else {
			resetSec = prev?.resetSec ?? 0;
			capturedAt = prev?.capturedAt ?? now;
		}
		out.push({
			scope: `codex:${slot}`,
			percent: clampP(remaining),
			hasReset: resetSec > 0,
			resetSec,
			capturedAt,
			windowDurationMins: windowMins ?? prev?.windowDurationMins,
			// Headers carry no credit information; keep what the last RPC reported.
			...(prev?.advisory ? { advisory: true } : {}),
		});
	};

	addSlot("primary");
	addSlot("secondary");
	return out;
}
