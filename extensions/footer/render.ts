import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { sep } from "node:path";
import { COPILOT_PROVIDER } from "../quota/quotas";
import type { FooterState } from "./state";
import { summarizeSessionUsage } from "./session-stats";

export interface FooterTheme {
	readonly name?: string;
	fg(color: string, text: string): string;
	bold(text: string): string;
	getColorMode?(): "truecolor" | "256color";
}

function isLightFooterTheme(theme: FooterTheme | undefined): boolean {
	const name = theme?.name?.toLowerCase() ?? "";
	if (name.includes("light")) return true;
	if (name.includes("dark")) return false;
	const background = Number(process.env.COLORFGBG?.split(";").at(-1));
	return Number.isFinite(background) && background >= 7;
}

/** Use a darker theme token for quota warnings on light themes. */
function footerWarningColor(theme: FooterTheme | undefined): string {
	return isLightFooterTheme(theme) ? "syntaxFunction" : "warning";
}

/** SGR foreground colour with a truecolor RGB value and an xterm-256 fallback. */
function sgrColor(theme: FooterTheme, rgb: readonly [number, number, number], xterm: number): string {
	if (theme.getColorMode?.() === "256color") return `\x1b[38;5;${xterm}m`;
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

/** High-contrast orange specifically for context warnings on light themes. */
function styleContextWarning(theme: FooterTheme | undefined, text: string): string {
	if (!theme) return text;
	if (!isLightFooterTheme(theme)) return theme.fg("warning", text);
	// Truecolor: orange-700 (#c2410c), 5.18:1 against white.
	// 256-color fallback: xterm 130 (#af5f00), 4.71:1 against white.
	return `${sgrColor(theme, [194, 65, 12], 130)}${text}\x1b[39m`;
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

/**
 * Throughput ("18t/s"): the number and the unit are coloured apart, mirroring
 * the provider/model split (value in accent, qualifier in dim) rather than a
 * single dedicated colour, so the segment reads like the rest of the band.
 */
function styleTokenSpeed(theme: FooterTheme | undefined, value: number): string {
	const speed = `${value}t/s`;
	if (!theme) return speed;
	return `${theme.fg("accent", `${value}`)}${theme.fg("dim", "t/s")}`;
}

function styleCopilotCredits(theme: FooterTheme | undefined, credits: string): string {
	const match = /^(\d+)\/(\d+)$/.exec(credits);
	if (!match || !theme) return credits;
	return `${theme.fg("accent", match[1])}/${theme.fg("dim", match[2])}`;
}

function styleSessionStat(theme: FooterTheme | undefined, text: string): string {
	return theme ? theme.fg("muted", text) : text;
}

/**
 * Cached input total ("1.2M" in "↑62k/1.2M"): a lighter gray than the muted
 * session numbers, tuned one step fainter after user feedback. Built-in themes
 * have no slot between "muted" (#808 dark / #6c light) and "text", so the
 * shade is pinned directly: #909090 on dark (brighter than muted, fainter than
 * the previous #999), #9a9a9a on light, with xterm-256 fallbacks.
 */
function styleCachedTokens(theme: FooterTheme | undefined, text: string): string {
	if (!theme) return text;
	const light = isLightFooterTheme(theme);
	return `${sgrColor(theme, light ? [154, 154, 154] : [144, 144, 144], light ? 247 : 245)}${text}\x1b[39m`;
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
 * Fit the single-line footer. Model information stays left-aligned and session
 * statistics stay right-aligned. On narrow terminals, optional model segments
 * are removed before compacting session statistics.
 */
function fitFooterLine(
	width: number,
	modelSegments: string[],
	sep: string,
	status: string,
	sessionVariants: string[],
	minGap = 2,
): string {
	const minModelSegments = Math.min(2, modelSegments.length);
	for (const session of sessionVariants) {
		for (let n = modelSegments.length; n >= minModelSegments; n--) {
			for (const suffix of status ? [`${sep}${status}`, ""] : [""]) {
				const left = `${modelSegments.slice(0, n).join(sep)}${suffix}`;
				if (visibleWidth(left) + minGap + visibleWidth(session) <= width) {
					return joinLR(width, left, session, minGap);
				}
			}
		}
	}

	const essential = modelSegments.slice(0, minModelSegments).join(sep);
	const session = sessionVariants.at(-1) ?? "";
	const maxSessionWidth = Math.max(0, Math.floor(width * 0.45));
	const fittedSession = truncateToWidth(session, maxSessionWidth, "");
	const leftWidth = Math.max(0, width - visibleWidth(fittedSession) - minGap);
	const fittedLeft = truncateToWidth(essential, leftWidth, "");
	return joinLR(width, fittedLeft, fittedSession, minGap);
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
	return truncateToWidth(`${projectRef}${gitChanges}`, width, "");
}

export function renderProjectLine(H: FooterRenderHandle, width: number, theme: FooterTheme | undefined): string {
	const fitted = renderProjectText(H, width, theme);
	return " ".repeat(Math.max(0, width - visibleWidth(fitted))) + fitted;
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

	// -- Left: model information --------------------------------------------
	const modelSegments: string[] = [];
	// Provider and model share a compact "provider/model" segment, distinguished
	// by color instead of the looser " · " separator used between other segments.
	const providerModel = `${fg("accent", state.currentModelProvider ?? "no-provider")}/${dim(state.currentModelId ?? "no-model")}`;
	if (state.currentModelReasoning) {
		modelSegments.push(`${providerModel} ${fg("accent", state.thinkingLevel || "off")}`);
	} else {
		modelSegments.push(providerModel);
	}

	if (state.currentModelProvider === COPILOT_PROVIDER && state.copilotCredits) {
		modelSegments.push(styleCopilotCredits(theme, state.copilotCredits));
	}

	const speedSegment =
		state.tokenSpeed != null && state.tokenSpeed > 0 ? styleTokenSpeed(theme, Math.round(state.tokenSpeed)) : undefined;

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

	// Token speed sits at the right end of the model line, after the quota
	// windows, rather than leading the session statistics on the right.
	if (speedSegment) modelSegments.push(speedSegment);

	// Extension statuses follow the model information on the footer's left.
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

	// -- Right: session statistics, closed by the context-window segment --
	const { totals, latestHit } = summarizeSessionUsage(ctx?.sessionManager);
	const usage = ctx?.getContextUsage();
	const contextTokens = usage?.tokens ?? null;
	const contextPercent = usage?.percent ?? 0;
	const contextWindow = usage?.contextWindow ?? 0;
	const contextText = contextTokens !== null && contextTokens > 0 ? formatTokens(contextTokens) : undefined;
	// Match ↑, ↓ and CH to the context-usage value, including its warning colors.
	// Keep their numeric values in the original muted session-stat color.
	const styleContextAccent = (text: string) =>
		contextPercent > 90
			? fg("error", text)
			: contextPercent > 70
				? styleContextWarning(theme, text)
				: fg("accent", text);

	const cacheTokens = totals.cacheRead + totals.cacheWrite;
	const cachePart = cacheTokens > 0 ? `/${styleCachedTokens(theme, formatTokens(cacheTokens))}` : "";
	const inputPart =
		totals.input > 0 || cacheTokens > 0
			? `${styleContextAccent("↑")}${styleSessionStat(theme, formatTokens(totals.input))}${cachePart}`
			: undefined;
	const contextPart = contextText === undefined ? undefined : styleContextAccent(contextText);
	const outputPart =
		totals.output > 0 ? `${styleContextAccent("↓")}${styleSessionStat(theme, formatTokens(totals.output))}` : undefined;
	const hitPart =
		totals.cacheRead > 0 && latestHit !== undefined
			? `${styleContextAccent("CH")}${styleSessionStat(theme, `${latestHit.toFixed(1)}%`)}`
			: undefined;
	// Session cost ("$0.123"), pi's own footer format: the $ shares the accent
	// color of the ↑/↓/CH markers, the amount stays muted. Only models with
	// cost rates report one; subscription-backed providers show quota windows
	// instead, so their cost stays hidden rather than reading "$0.000 (sub)".
	const costPart =
		totals.cost > 0 ? `${styleContextAccent("$")}${styleSessionStat(theme, totals.cost.toFixed(3))}` : undefined;
	// Context-window segment: current context tokens / window total ("66k/1.0M").
	// The usage number is accent (warning/error past its thresholds); the fixed
	// total stays dim, mirroring the cwd/branch split of the project line.
	const windowPart =
		contextPart === undefined
			? undefined
			: contextWindow > 0
				? `${contextPart}/${dim(formatTokens(contextWindow))}`
				: contextPart;

	const quantityStats = [inputPart, outputPart, hitPart, costPart].filter((part): part is string => part !== undefined);
	const compactQuantity = [inputPart, outputPart, costPart].filter((part): part is string => part !== undefined);
	// Token speed now leads the model line on the left, so the right side is
	// input/cache, output, cache-hit and cost statistics, closed by the
	// context/window segment behind a "·" separator.
	const fullSessionParts =
		quantityStats.length > 0
			? windowPart
				? [...quantityStats, `${dim("·")} ${windowPart}`]
				: quantityStats
			: windowPart
				? [windowPart]
				: [];
	const compactSessionParts = compactQuantity.length > 0 ? compactQuantity : windowPart ? [windowPart] : [];
	const sessionVariants = Array.from(
		new Set([fullSessionParts.join(" "), compactSessionParts.join(" "), ...(windowPart ? [windowPart] : [])]),
	);
	if (sessionVariants.length === 0) sessionVariants.push("");

	const line = fitFooterLine(width, modelSegments, sep, status, sessionVariants, 2);
	return [truncateToWidth(line, width, "")];
}
