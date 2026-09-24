import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compareRateWindows, type RateWindow } from "./headers";
import { toFiniteNumber } from "./shared";

interface ZaiQuotaLimitPayload {
	type?: string;
	unit?: number;
	percentage?: number;
	remaining?: number;
	nextResetTime?: number;
	/** TIME_LIMIT rows: total count for the window. */
	usage?: number;
	/** TIME_LIMIT rows: spent count. */
	currentValue?: number;
}

interface ZaiQuotaPayload {
	success?: boolean;
	msg?: string;
	data?: { limits?: ZaiQuotaLimitPayload[]; level?: string };
}

/**
 * ZAI quota monitor endpoint and unit mapping, independently integrated from
 * the MIT-licensed @beyona/pi-zai-usage implementation (v0.4.0).
 *
 * The provider's model base URL picks the gateway, and the provider id the
 * credential: `zai-coding-cn` (China GLM Coding Plan, open.bigmodel.cn) probes
 * the China mirror with its own key; a zai* provider on api.z.ai uses api.z.ai.
 * Providers on any other host are not queried. Both hosts serve the same contract and follow
 * the account's plan, not the host (a China coding-plan key returns identical
 * CREDIT_LIMIT rows from either gateway). Auth failures come back as HTTP 200
 * with an error envelope ({"success":false,...}) — checked below.
 */
const ZAI_QUOTA_URLS = {
	zai: "https://api.z.ai/api/monitor/usage/quota/limit",
	"zai-coding-cn": "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
} as const;

/**
 * Pick the monitor endpoint from where the provider's models actually send requests.
 * A custom provider that only happens to be named "zai…" (e.g. an OpenRouter or proxy
 * entry in models.json) gets undefined, so its unrelated API key is never sent to Z.AI.
 */
function zaiQuotaUrl(modelRegistry: ExtensionContext["modelRegistry"], provider: string): string | undefined {
	const hosts = modelRegistry
		.getAll()
		.filter((model) => model.provider === provider)
		.map((model) => {
			try {
				return new URL(model.baseUrl).hostname.toLowerCase();
			} catch {
				return "";
			}
		});
	const onHost = (domain: string) => hosts.some((host) => host === domain || host.endsWith(`.${domain}`));
	if (onHost("bigmodel.cn")) return ZAI_QUOTA_URLS["zai-coding-cn"];
	if (onHost("z.ai")) return ZAI_QUOTA_URLS.zai;
	return undefined;
}

export async function readZaiRateLimits(
	modelRegistry: ExtensionContext["modelRegistry"],
	provider: string | undefined,
): Promise<RateWindow[]> {
	const quotaUrl = zaiQuotaUrl(modelRegistry, provider ?? "zai");
	if (!quotaUrl) return [];
	const apiKey = await modelRegistry.getApiKeyForProvider(provider ?? "zai");
	const headers: Record<string, string> = { "Accept-Encoding": "identity" };
	if (apiKey && apiKey !== "proxy-managed") {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	try {
		const response = await fetch(quotaUrl, {
			headers,
			signal: controller.signal,
		});
		if (!response.ok) return [];
		const payload = (await response.json()) as ZaiQuotaPayload;
		if (payload.success === false) return [];
		const limits = payload.data?.limits ?? [];
		// GLM coding-plan quota windows come in two encodings sharing the same
		// field names: credit-metered plans (observed on zai-coding-cn) report
		// CREDIT_LIMIT rows where `percentage` is the USED percent, `usage` is
		// the window cap in credits and `remaining` an absolute credit count;
		// token-metered international plans report legacy TOKENS_LIMIT rows.
		// unit 3 = the 5-hour window, unit 6 = the weekly (7d) window, and
		// TIME_LIMIT unit 5 = the monthly/total window, returned only by some
		// plan tiers (a lite China plan sends just 5h + weekly rows).
		const tokenLimits = limits.filter((item) => item.type === "CREDIT_LIMIT" || item.type === "TOKENS_LIMIT");
		const fiveHour = tokenLimits.find((item) => item.unit === 3);
		const weekly = tokenLimits.find((item) => item.unit === 6);
		const monthly = limits.find((item) => item.type === "TIME_LIMIT" && item.unit === 5);
		const now = Date.now();

		const toWindow = (
			limit: ZaiQuotaLimitPayload | undefined,
			scope: string,
			windowDurationMins: number | undefined,
			showReset: boolean,
		): RateWindow | undefined => {
			if (!limit || typeof limit.percentage !== "number") return undefined;
			// CREDIT_LIMIT: percentage = used and `remaining` is credits (NOT a
			// percent), so the leftover percent is always derived. TOKENS_LIMIT
			// keeps the original semantics: `remaining`, when present, already is
			// a percent.
			const left =
				limit.type === "CREDIT_LIMIT"
					? 100 - limit.percentage
					: typeof limit.remaining === "number"
						? limit.remaining
						: 100 - limit.percentage;
			const resetAt = typeof limit.nextResetTime === "number" ? limit.nextResetTime : 0;
			const resetSec = showReset && resetAt > now ? (resetAt - now) / 1000 : 0;
			return {
				scope,
				percent: Math.max(0, Math.min(100, left)),
				hasReset: resetSec > 0,
				resetSec,
				capturedAt: now,
				windowDurationMins,
			};
		};

		// The monthly TIME_LIMIT row is not a token quota: it meters auxiliary-
		// tool invocations (search-prime / web-reader / zread), where `usage` is
		// the window total, `currentValue` the spent count and `remaining` an
		// absolute count. Derive the remaining percent from those counts; the
		// generic path would misread `remaining` itself as a percent (975 -> 100%).
		const toMonthlyWindow = (limit: ZaiQuotaLimitPayload | undefined): RateWindow | undefined => {
			if (!limit) return undefined;
			const total = toFiniteNumber(limit.usage);
			const used = toFiniteNumber(limit.currentValue);
			const left =
				toFiniteNumber(limit.remaining) ?? (used !== undefined && total !== undefined ? total - used : undefined);
			if (total === undefined || total <= 0 || left === undefined) return undefined;
			return {
				scope: "zai:monthly",
				percent: Math.max(0, Math.min(100, (left / total) * 100)),
				hasReset: false,
				resetSec: 0,
				capturedAt: now,
				// Tool invocations only; running out does not block the models.
				advisory: true,
			};
		};

		const windows = [
			toWindow(fiveHour, "zai:3", 5 * 60, true),
			toWindow(weekly, "zai:6", 7 * 24 * 60, true),
			// Monthly tools quota as a remaining percent. Plans without the row
			// show just the 5h and 7d windows.
			toMonthlyWindow(monthly),
		].filter((window): window is RateWindow => window !== undefined);
		windows.sort(compareRateWindows);
		return windows;
	} catch {
		return [];
	} finally {
		clearTimeout(timeout);
	}
}

export function isZaiProvider(provider: string | undefined): boolean {
	return provider?.toLowerCase().startsWith("zai") ?? false;
}
