import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CHATGPT_QUOTA_KEY,
	COPILOT_PROVIDER,
	isOpenCodeGoProvider,
	isOpenAIChatGPTLimitError,
	isZaiProvider,
	hasRecentChatGPTLimit,
	quotaKey,
	readCodexRateLimits,
	readGitHubCopilotCredits,
	readOpenCodeGoRateLimits,
	readZaiRateLimits,
	type RateWindow,
} from "./quotas";

/** Keyed by quotaKey: the provider, or CHATGPT_QUOTA_KEY for the ChatGPT sign-in. */
export interface ProviderQuotaSnapshot {
	windows: RateWindow[];
	copilotCredits?: string;
	/** A live ChatGPT app-limit denial (CHATGPT_QUOTA_KEY only); no percentage or reset time is implied. */
	chatgptLimitAt?: number;
	updatedAt: number;
}

export const QUOTA_CACHE_MS = 60_000;
/** A window without a reset time only proves exhaustion while its reading is recent. */
const UNTIMED_WINDOW_TRUST_MS = 5 * 60_000;

interface ProviderQuotaStore {
	providerQuotas: Map<string, ProviderQuotaSnapshot>;
	inFlight: Map<string, Promise<ProviderQuotaSnapshot | undefined>>;
	requestVersions: Map<string, number>;
}

// Keep snapshots shared between the footer and model cycling even if Pi loads
// separate copies of this module (for example, across extension reloads).
const STORE_KEY: unique symbol = Symbol.for("pi-better-footer.provider-quota.v1");
const storeHost = globalThis as typeof globalThis & { [STORE_KEY]?: ProviderQuotaStore };
storeHost[STORE_KEY] ??= {
	providerQuotas: new Map(),
	inFlight: new Map(),
	requestVersions: new Map(),
};
const store = storeHost[STORE_KEY];

export const providerQuotas = store.providerQuotas;
const { inFlight, requestVersions } = store;

export function rememberProviderQuota(
	provider: string,
	update: Partial<Pick<ProviderQuotaSnapshot, "windows" | "copilotCredits" | "chatgptLimitAt">>,
): void {
	const previous = providerQuotas.get(provider);
	providerQuotas.set(provider, {
		windows: update.windows ?? previous?.windows ?? [],
		copilotCredits: update.copilotCredits ?? previous?.copilotCredits,
		chatgptLimitAt: "chatgptLimitAt" in update ? update.chatgptLimitAt : previous?.chatgptLimitAt,
		updatedAt: Date.now(),
	});
}

/**
 * Read a provider's quota, reusing a snapshot younger than `maxAgeMs` and
 * coalescing with an in-flight request unless `force` is set. Callers that own
 * their own polling cadence pass `maxAgeMs = 0` so the cache cannot swallow
 * every other scheduled refresh.
 */
export async function readProviderQuota(
	provider: string,
	ctx: ExtensionContext,
	force = false,
	maxAgeMs = QUOTA_CACHE_MS,
): Promise<ProviderQuotaSnapshot | undefined> {
	const cached = providerQuotas.get(provider);
	if (!force && cached && Date.now() - cached.updatedAt < maxAgeMs) return cached;
	const pending = inFlight.get(provider);
	if (!force && pending) return pending;
	// Forced refreshes on a new session supersede reads still pending from the old one.
	const version = (requestVersions.get(provider) ?? 0) + 1;
	requestVersions.set(provider, version);
	const request = (async () => {
		let windows: RateWindow[] = [];
		let copilotCredits: string | undefined;
		try {
			if (provider === COPILOT_PROVIDER) copilotCredits = await readGitHubCopilotCredits();
			else if (provider === "openai-codex") windows = await readCodexRateLimits();
			else if (isZaiProvider(provider)) windows = await readZaiRateLimits(ctx.modelRegistry, provider);
			else if (isOpenCodeGoProvider(provider)) windows = await readOpenCodeGoRateLimits(ctx.modelRegistry);
		} catch {
			return providerQuotas.get(provider);
		}
		// A newer refresh or response-header update takes priority.
		if (requestVersions.get(provider) !== version || providerQuotas.get(provider) !== cached) {
			return providerQuotas.get(provider);
		}
		if (copilotCredits !== undefined) rememberProviderQuota(provider, { copilotCredits });
		if (windows.length > 0) rememberProviderQuota(provider, { windows });
		return providerQuotas.get(provider);
	})();
	inFlight.set(provider, request);
	try {
		return await request;
	} finally {
		if (inFlight.get(provider) === request) inFlight.delete(provider);
	}
}

/**
 * Record ChatGPT app-limit denials, and clear them on a success, for the model
 * each reply came from: the selection may have changed while it streamed.
 * Registered on its own so the footer and model cycling both read the result.
 */
export function trackChatGPTLimits(pi: ExtensionAPI): void {
	pi.on("message_end", (event, ctx) => {
		const msg = event.message as
			| { role?: string; provider?: string; model?: string; errorMessage?: string; stopReason?: string }
			| undefined;
		if (msg?.role !== "assistant" || !msg.provider || !msg.model) return;
		const model = ctx.modelRegistry.find(msg.provider, msg.model);
		if (quotaKey(model, ctx.modelRegistry) !== CHATGPT_QUOTA_KEY) return;
		if (msg.errorMessage && isOpenAIChatGPTLimitError(msg.errorMessage)) {
			// This is an app/permission usage limit, not evidence that the
			// entire plan is at 0% or will reset after a guessed duration.
			rememberProviderQuota(CHATGPT_QUOTA_KEY, { chatgptLimitAt: Date.now() });
		} else if (!msg.errorMessage && msg.stopReason !== "error" && msg.stopReason !== "aborted") {
			rememberProviderQuota(CHATGPT_QUOTA_KEY, { chatgptLimitAt: undefined });
		}
	});
}

export function isQuotaExhausted(snapshot: ProviderQuotaSnapshot | undefined): boolean {
	if (!snapshot) return false;
	if (hasRecentChatGPTLimit(snapshot.chatgptLimitAt)) return true;
	// Every Copilot model consumes premium requests, so "0/N" blocks the whole provider.
	const credits = snapshot.copilotCredits?.match(/^(\d+)\//);
	if (credits && Number(credits[1]) <= 0) return true;
	const now = Date.now();
	return snapshot.windows.some((window) => {
		// Advisory windows (e.g. Z.AI's monthly tool-call allowance) never block the model itself.
		if (window.advisory || window.percent > 0) return false;
		if (!window.hasReset) return now - window.capturedAt < UNTIMED_WINDOW_TRUST_MS;
		return window.resetSec - (now - window.capturedAt) / 1000 > 0;
	});
}
