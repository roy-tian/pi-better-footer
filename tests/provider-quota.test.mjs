import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import {
	CHATGPT_QUOTA_KEY,
	hasRecentChatGPTLimit,
	isOpenAIChatGPTLimitError,
	quotaKey,
} from "../extensions/quota/openai.ts";

const source = stripTypeScriptTypes(
	await readFile(new URL("../extensions/quota/provider-quota.ts", import.meta.url), "utf8"),
);
const window = (percent) => ({ scope: "codex:primary", percent, hasReset: false, resetSec: 0, capturedAt: Date.now() });

async function service(readCodexRateLimits, context = createContext({ Date, console })) {
	const module = new SourceTextModule(source, { context });
	const quotas = {
		CHATGPT_QUOTA_KEY,
		hasRecentChatGPTLimit,
		isOpenAIChatGPTLimitError,
		quotaKey,
		COPILOT_PROVIDER: "github-copilot",
		isZaiProvider: () => false,
		isOpenCodeGoProvider: () => false,
		readCodexRateLimits,
		readGitHubCopilotCredits: async () => undefined,
		readOpenCodeGoRateLimits: async () => [],
		readZaiRateLimits: async () => [],
	};
	await module.link(async (specifier) => {
		assert.equal(specifier, "./quotas");
		return new SyntheticModule(
			Object.keys(quotas),
			function () {
				for (const [key, value] of Object.entries(quotas)) this.setExport(key, value);
			},
			{ context },
		);
	});
	await module.evaluate();
	return module.namespace;
}

test("footer and model cycle share fresh quota data without another request", async () => {
	let calls = 0;
	const quotas = await service(async () => {
		calls++;
		return [window(0)];
	});
	const ctx = { modelRegistry: {} };
	const first = await quotas.readProviderQuota("openai-codex", ctx);
	assert.equal(calls, 1);
	const second = await quotas.readProviderQuota("openai-codex", ctx);
	assert.equal(calls, 1);
	assert.equal(first, second);
	assert.equal(quotas.isQuotaExhausted(second), true);
	quotas.rememberProviderQuota("openai-codex", { windows: [window(70)] });
	assert.equal(quotas.isQuotaExhausted(await quotas.readProviderQuota("openai-codex", ctx)), false);
	assert.equal(calls, 1);
});

test("simultaneous quota lookups coalesce; a new session's forced refresh wins over an old response", async () => {
	const resolvers = [];
	const quotas = await service(() => new Promise((resolve) => resolvers.push(resolve)));
	const ctx = { modelRegistry: {} };
	const earlier = quotas.readProviderQuota("openai-codex", ctx);
	const duplicate = quotas.readProviderQuota("openai-codex", ctx);
	assert.equal(resolvers.length, 1);
	const latest = quotas.readProviderQuota("openai-codex", ctx, true);
	assert.equal(resolvers.length, 2);
	resolvers[1]([window(80)]);
	assert.equal((await latest).windows[0].percent, 80);
	resolvers[0]([window(0)]);
	await Promise.all([earlier, duplicate]);
	assert.equal(quotas.providerQuotas.get("openai-codex").windows[0].percent, 80);
});

test("expired reset windows are not treated as exhausted", async () => {
	const quotas = await service(async () => []);
	assert.equal(
		quotas.isQuotaExhausted({
			windows: [{ ...window(0), hasReset: true, resetSec: 1, capturedAt: Date.now() - 10_000 }],
		}),
		false,
	);
});

test("separately loaded extension copies share one quota cache", async () => {
	let calls = 0;
	const context = createContext({ Date, console });
	const read = async () => {
		calls++;
		return [window(0)];
	};
	const footer = await service(read, context);
	const cycle = await service(read, context);
	assert.notEqual(footer, cycle);
	const ctx = { modelRegistry: {} };
	await footer.readProviderQuota("openai-codex", ctx);
	assert.equal(cycle.isQuotaExhausted(await cycle.readProviderQuota("openai-codex", ctx)), true);
	assert.equal(calls, 1);
});

test("advisory and stale untimed windows do not mark a provider exhausted", async () => {
	const quotas = await service(async () => []);
	assert.equal(quotas.isQuotaExhausted({ windows: [{ ...window(0), scope: "zai:monthly", advisory: true }] }), false);
	assert.equal(quotas.isQuotaExhausted({ windows: [{ ...window(0), capturedAt: Date.now() - 10 * 60_000 }] }), false);
	assert.equal(quotas.isQuotaExhausted({ windows: [window(0)] }), true);
});

test("used-up Copilot premium credits mark the provider exhausted", async () => {
	const quotas = await service(async () => []);
	assert.equal(quotas.isQuotaExhausted({ windows: [], copilotCredits: "0/300" }), true);
	assert.equal(quotas.isQuotaExhausted({ windows: [], copilotCredits: "1/300" }), false);
});

test("a zero max age refetches instead of returning the cached snapshot", async () => {
	let calls = 0;
	const quotas = await service(async () => {
		calls++;
		return [window(50)];
	});
	const ctx = { modelRegistry: {} };
	await quotas.readProviderQuota("openai-codex", ctx);
	await quotas.readProviderQuota("openai-codex", ctx);
	assert.equal(calls, 1);
	await quotas.readProviderQuota("openai-codex", ctx, false, 0);
	assert.equal(calls, 2);
});

test("OpenAI app limits are cached separately from numeric windows and expire or clear", async () => {
	let calls = 0;
	const quotas = await service(async () => {
		calls++;
		return [window(0)];
	});
	const ctx = { modelRegistry: {} };
	quotas.rememberProviderQuota(CHATGPT_QUOTA_KEY, { chatgptLimitAt: Date.now() });
	const limited = await quotas.readProviderQuota(CHATGPT_QUOTA_KEY, ctx);
	assert.equal(limited.windows.length, 0);
	assert.equal(quotas.isQuotaExhausted(limited), true);
	// The API-key account under the plain provider id is a different account.
	assert.equal(await quotas.readProviderQuota("openai", ctx), undefined);
	assert.equal(calls, 0); // Never spawn Codex or borrow its account for openai.
	quotas.rememberProviderQuota(CHATGPT_QUOTA_KEY, { chatgptLimitAt: Date.now() - 5 * 60_000 });
	assert.equal(quotas.isQuotaExhausted(await quotas.readProviderQuota(CHATGPT_QUOTA_KEY, ctx)), false);
	quotas.rememberProviderQuota(CHATGPT_QUOTA_KEY, { chatgptLimitAt: undefined });
	assert.equal(quotas.providerQuotas.get(CHATGPT_QUOTA_KEY).chatgptLimitAt, undefined);
	assert.equal(quotas.isQuotaExhausted(await quotas.readProviderQuota(CHATGPT_QUOTA_KEY, ctx)), false);
});

async function chatgptTracker() {
	const quotas = await service(async () => []);
	const models = {
		chatgpt: { provider: "openai", id: "chatgpt", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
		proxy: { provider: "openai", id: "proxy", api: "openai-responses", baseUrl: "https://proxy.example/v1" },
		virtual: { provider: "openai", id: "auto", api: "pi-virtual", baseUrl: "https://api.openai.com/v1" },
	};
	const ctx = {
		// Deliberately unrelated to the replies below: attribution follows the message.
		model: models.proxy,
		modelRegistry: {
			find: (provider, id) => Object.values(models).find((m) => m.provider === provider && m.id === id),
			isUsingOAuth: () => true,
		},
	};
	let handler;
	quotas.trackChatGPTLimits({
		on: (name, fn) => {
			assert.equal(name, "message_end");
			handler = fn;
		},
	});
	const end = (model, errorMessage, stopReason = errorMessage ? "error" : "stop", role = "assistant") =>
		handler({ message: { role, provider: "openai", model, errorMessage, stopReason } }, ctx);
	const limitAt = () => quotas.providerQuotas.get(CHATGPT_QUOTA_KEY)?.chatgptLimitAt;
	return { quotas, end, limitAt };
}

test("ChatGPT limits follow the model that replied, not the current selection", async () => {
	const { quotas, end, limitAt } = await chatgptTracker();
	end("chatgpt", "subscription_sharing_usage_limit_exceeded", "error", "toolResult");
	assert.equal(limitAt(), undefined);
	// An API-key or virtual reply is a different account; it neither sets nor clears the limit.
	end("proxy", "subscription_sharing_usage_limit_exceeded");
	end("virtual", "subscription_sharing_usage_limit_exceeded");
	end("unknown", "subscription_sharing_usage_limit_exceeded");
	assert.equal(limitAt(), undefined);
	end("chatgpt", "subscription_sharing_usage_limit_exceeded: app limit");
	assert.ok(limitAt());
	assert.equal(quotas.providerQuotas.has("openai"), false);
	end("proxy");
	end("virtual");
	assert.ok(limitAt());
	end("chatgpt", "temporary network error");
	end("chatgpt", "subscription_sharing_usage_unavailable");
	end("chatgpt", undefined, "aborted");
	assert.ok(limitAt());
	end("chatgpt");
	assert.equal(limitAt(), undefined);
});
