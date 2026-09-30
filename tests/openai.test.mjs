import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CHATGPT_LIMIT_TRUST_MS,
	CHATGPT_QUOTA_KEY,
	hasRecentChatGPTLimit,
	isOpenAIChatGPTLimitError,
	isOpenAIChatGPTModel,
	quotaKey,
} from "../extensions/quota/openai.ts";

const model = { provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", id: "test" };

test("ChatGPT detection requires OpenAI OAuth on the official host, never a token read", () => {
	let reads = 0;
	const registry = {
		isUsingOAuth: () => true,
		getApiKeyForProvider: () => {
			reads++;
			throw new Error("must not resolve or send credentials");
		},
	};
	assert.equal(isOpenAIChatGPTModel(model, registry), true);
	for (const alternative of [
		undefined,
		{ ...model, provider: "openai-codex" },
		{ ...model, api: "pi-virtual" },
		{ ...model, baseUrl: "https://proxy.example.com/v1" },
		{ ...model, baseUrl: "https://api.openai.com.example.com/v1" },
		{ ...model, baseUrl: "invalid" },
	]) {
		assert.equal(isOpenAIChatGPTModel(alternative, registry), false);
	}
	assert.equal(isOpenAIChatGPTModel(model, { isUsingOAuth: () => false }), false);
	assert.equal(isOpenAIChatGPTModel(model, {}), false);
	assert.equal(reads, 0);
});

test("the ChatGPT sign-in has its own quota key; a virtual model has none", () => {
	const oauth = { isUsingOAuth: () => true };
	assert.equal(quotaKey(model, oauth), CHATGPT_QUOTA_KEY);
	assert.equal(quotaKey(model, { isUsingOAuth: () => false }), "openai");
	assert.equal(quotaKey({ ...model, baseUrl: "https://proxy.example.com/v1" }, oauth), "openai");
	assert.equal(quotaKey({ ...model, provider: "zai" }, oauth), "zai");
	assert.equal(quotaKey({ ...model, api: "pi-virtual" }, oauth), undefined);
	assert.equal(quotaKey({ ...model, provider: "zai", api: "pi-virtual" }, oauth), undefined);
	assert.equal(quotaKey(undefined, oauth), undefined);
});

test("only the precise ChatGPT app-limit error proves a usage restriction", () => {
	for (const error of [
		'429 {"error":{"code":"subscription_sharing_usage_limit_exceeded"}}',
		"subscription_sharing_usage_limit_exceeded: App usage limit reached\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage",
	]) {
		assert.equal(isOpenAIChatGPTLimitError(error), true);
	}
	for (const error of [
		"429 rate_limit_exceeded",
		"subscription_sharing_usage_unavailable",
		"subscription_sharing_user_not_eligible",
		"subscription_sharing_usage_limit_exceeded_extra",
		"usage limit reached",
	]) {
		assert.equal(isOpenAIChatGPTLimitError(error), false);
	}
});

test("an untimed ChatGPT app limit expires without inventing a reset time", () => {
	const now = 1_000_000;
	assert.equal(hasRecentChatGPTLimit(now, now), true);
	assert.equal(hasRecentChatGPTLimit(now - CHATGPT_LIMIT_TRUST_MS + 1, now), true);
	assert.equal(hasRecentChatGPTLimit(now - CHATGPT_LIMIT_TRUST_MS, now), false);
	assert.equal(hasRecentChatGPTLimit(now + 1, now), false);
	assert.equal(hasRecentChatGPTLimit(undefined, now), false);
});
