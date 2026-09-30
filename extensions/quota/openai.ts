import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
/** A recent denial proves this app is limited, not that the whole plan is empty. */
export const CHATGPT_LIMIT_TRUST_MS = 5 * 60_000;
/** Quota-cache key of the ChatGPT sign-in, which bills separately from OpenAI API keys. */
export const CHATGPT_QUOTA_KEY = "openai:chatgpt";

/**
 * The account a model's quota is cached under: its provider, except that the
 * ChatGPT sign-in has its own. A virtual model can route anywhere, so it has none.
 */
export function quotaKey(
	model: ExtensionContext["model"],
	registry: ExtensionContext["modelRegistry"],
): string | undefined {
	if (!model || model.api === "pi-virtual") return undefined;
	return isOpenAIChatGPTModel(model, registry) ? CHATGPT_QUOTA_KEY : model.provider;
}

/** Only Pi's OpenAI OAuth model on the official API uses the new ChatGPT plan flow. */
export function isOpenAIChatGPTModel(
	model: ExtensionContext["model"],
	registry: ExtensionContext["modelRegistry"],
): boolean {
	if (model?.provider !== "openai" || model.api === "pi-virtual") return false;
	try {
		return new URL(model.baseUrl).hostname === "api.openai.com" && registry.isUsingOAuth(model);
	} catch {
		return false;
	}
}

/** Do not confuse temporary usage-check failures or ordinary API rate limits with a plan denial. */
export function isOpenAIChatGPTLimitError(error: string): boolean {
	return /\bsubscription_sharing_usage_limit_exceeded\b/.test(error);
}

export function hasRecentChatGPTLimit(capturedAt: number | undefined, now = Date.now()): boolean {
	return capturedAt !== undefined && now >= capturedAt && now - capturedAt < CHATGPT_LIMIT_TRUST_MS;
}
