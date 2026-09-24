// Rate-limit window detection from response headers
// ---------------------------------------------------------------------------

interface RawWindow {
	key: string; // prefix|scope, used to group limit/remaining/reset
	scope: string; // e.g. "tokens", "requests"
	limit?: number;
	remaining?: number;
	used?: number;
	reset?: string; // raw reset value (seconds, duration string, or ISO date)
}

export interface RateWindow {
	scope: string;
	percent: number; // 0..100 remaining
	hasReset: boolean;
	resetSec: number; // seconds remaining at capture time
	capturedAt: number; // ms epoch
	/** Known quota-window size; used to order 5h before weekly before total. */
	windowDurationMins?: number;
	/** Displayed only; exhausting it does not make the provider's models unusable. */
	advisory?: boolean;
}

function rateWindowSortKey(window: RateWindow): number {
	if (window.windowDurationMins !== undefined) return window.windowDurationMins;
	if (window.hasReset) return window.resetSec / 60;
	return Number.POSITIVE_INFINITY;
}

export function compareRateWindows(a: RateWindow, b: RateWindow): number {
	return rateWindowSortKey(a) - rateWindowSortKey(b);
}

function num(v: string | undefined): number | undefined {
	if (v === undefined) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function parseDuration(str: string): number | undefined {
	// e.g. "6m0s", "1h30m", "500ms", "2d", "10s"
	let total = 0;
	let matched = false;
	// Note: no \b after the unit — OpenAI returns concatenated durations like "6m0s".
	const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi;
	for (const m of str.matchAll(re)) {
		matched = true;
		const v = Number(m[1]);
		switch (m[2].toLowerCase()) {
			case "ms":
				total += v / 1000;
				break;
			case "s":
				total += v;
				break;
			case "m":
				total += v * 60;
				break;
			case "h":
				total += v * 3600;
				break;
			case "d":
				total += v * 86400;
				break;
		}
	}
	return matched ? total : undefined;
}

function parseReset(raw: string): number | undefined {
	const v = raw.trim();
	// Plain number -> seconds (anthropic reset-ttl), unless it is clearly an
	// absolute epoch timestamp (seconds or milliseconds), as some providers send.
	if (/^\d+(\.\d+)?$/.test(v)) {
		const n = Number(v);
		if (n >= 1e12) return Math.max(0, (n - Date.now()) / 1000);
		if (n >= 1e9) return Math.max(0, n - Date.now() / 1000);
		return n;
	}
	// ISO-8601 timestamp -> absolute reset time
	if (/[T:-]/.test(v) && /\d{4}-\d{2}-\d{2}/.test(v)) {
		const t = Date.parse(v);
		if (Number.isFinite(t)) return Math.max(0, (t - Date.now()) / 1000);
	}
	// Duration string (openai: "6m0s")
	return parseDuration(v);
}

/** Detect rate-limit windows from headers, understanding OpenAI & Anthropic naming. */
export function detectRateWindows(headers: Record<string, string>): RawWindow[] {
	const map = new Map<string, RawWindow>();
	const ensure = (prefix: string, scope: string): RawWindow => {
		const key = `${prefix}|${scope}`;
		let w = map.get(key);
		if (!w) {
			w = { key, scope };
			map.set(key, w);
		}
		return w;
	};

	// Order matters: check longer/more-specific suffixes first.
	// Each entry: [regex, field]. $1 = prefix, $2 = scope.
	const rules: Array<[RegExp, "limit" | "remaining" | "used" | "reset"]> = [
		[/^(.+)-(.+)-reset-ttl$/, "reset"],
		[/^(.+)-reset-ttl-(.+)$/, "reset"],
		[/^(.+)-(.+)-reset$/, "reset"],
		[/^(.+)-reset-(.+)$/, "reset"],
		[/^(.+)-(.+)-remaining$/, "remaining"],
		[/^(.+)-remaining-(.+)$/, "remaining"],
		[/^(.+)-(.+)-used$/, "used"],
		[/^(.+)-used-(.+)$/, "used"],
		[/^(.+)-(.+)-limit$/, "limit"],
		[/^(.+)-limit-(.+)$/, "limit"],
	];

	for (const [origKey, origVal] of Object.entries(headers)) {
		const key = origKey.toLowerCase();
		const val = (origVal ?? "").trim();
		if (!val) continue;
		for (const [re, field] of rules) {
			const m = key.match(re);
			if (!m) continue;
			const w = ensure(m[1], m[2]);
			if (field === "limit") w.limit = num(val);
			else if (field === "remaining") w.remaining = num(val);
			else if (field === "used") w.used = num(val);
			else w.reset = val;
			break;
		}
	}
	return [...map.values()];
}

/** Convert raw windows into display windows, preferring token-scoped ones. */
export function toRateWindows(raw: RawWindow[]): RateWindow[] {
	const withLimit = raw.filter((w) => w.limit !== undefined && (w.remaining !== undefined || w.used !== undefined));
	// Prefer token-scoped windows; fall back to anything.
	let pool = withLimit.filter((w) => /token/i.test(w.scope));
	if (pool.length === 0) pool = withLimit;

	const out: RateWindow[] = pool.map((w) => {
		// biome-ignore lint/style/noNonNullAssertion: withLimit keeps only windows that have a limit.
		const limit = w.limit!;
		const remaining = w.remaining !== undefined ? w.remaining : limit - (w.used ?? limit);
		const percent = limit > 0 ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : 0;
		const parsedReset = w.reset !== undefined ? parseReset(w.reset) : undefined;
		const resetSec = parsedReset ?? 0;
		return {
			scope: w.scope,
			percent,
			// A reset of "0s" (or a past timestamp) means the window has just reset:
			// keep it timed and expired, not untimed and trusted as exhausted.
			hasReset: parsedReset !== undefined,
			resetSec,
			capturedAt: Date.now(),
		};
	});

	// 5h before weekly before no-reset total windows.
	out.sort(compareRateWindows);
	return out;
}

/**
 * ZAI exposes Coding Plan window details only after the limit is exhausted.
 * pi preserves the provider body in AssistantMessage.errorMessage, e.g.:
 *
 *   429: {"code":"1308","message":"Usage limit reached for 5 hour.
 *   Your limit will reset at 2026-07-22 16:02:22"}
 *
 * or, from the open.bigmodel.cn gateway:
 *
 *   429 已达到 5 小时的使用上限。您的限额将在 2026-09-06 09:04:58 重置。
 *
 * This is a fallback for cases where the quota monitor endpoint is unavailable.
 * A 429 means the affected window is fully consumed, so it has 0% remaining.
 */
const LIMIT_ERROR_PATTERNS = [
	/Usage limit reached for\s+(.+?)\.\s*Your limit will reset at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/i,
	/已达到\s*(.+?)的?使用上限[\s\S]*?将在\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*重置/,
];
/** Both gateways print the reset as zone-less Beijing time, whatever the client's timezone. */
const ZAI_RESET_UTC_OFFSET = "+08:00";

export function parseLimitError(errorMessage: string): RateWindow | undefined {
	const match = LIMIT_ERROR_PATTERNS.map((pattern) => pattern.exec(errorMessage)).find(Boolean);
	if (!match) return undefined;

	const resetAt = Date.parse(`${match[2]}T${match[3]}${ZAI_RESET_UTC_OFFSET}`);
	if (!Number.isFinite(resetAt)) return undefined;
	const now = Date.now();
	const resetSec = (resetAt - now) / 1000;
	if (resetSec <= 0) return undefined;

	let scope = match[1].trim().toLowerCase();
	let windowDurationMins: number | undefined;
	const hours = /(\d+(?:\.\d+)?)\s*(?:hour|小时)/i.exec(scope);
	if (hours) {
		windowDurationMins = Number(hours[1]) * 60;
		if (Number(hours[1]) === 5) scope = "zai:3";
	} else if (/week|周/i.test(scope)) {
		windowDurationMins = 7 * 24 * 60;
		scope = "zai:6";
	}

	return {
		scope,
		percent: 0,
		hasReset: true,
		resetSec,
		capturedAt: now,
		windowDurationMins,
	};
}
