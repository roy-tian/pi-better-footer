import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { CHATGPT_QUOTA_KEY, hasRecentChatGPTLimit, quotaKey } from "../extensions/quota/openai.ts";

const source = stripTypeScriptTypes(
	await readFile(new URL("../extensions/skip-unavailable.ts", import.meta.url), "utf8"),
);
// The skip check runs detached after Pi's cycle; let its timers and reads finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const window = (percent) => ({ percent, hasReset: false, resetSec: 0, capturedAt: Date.now() });
const models = [
	{ model: { provider: "openai-codex", id: "a" } },
	{ model: { provider: "zai", id: "b" }, thinkingLevel: "high" },
	{ model: { provider: "opencode-go", id: "c", reasoning: true }, thinkingLevel: "medium" },
];

async function harness(
	quota = new Map(),
	readQuota = async (provider) => quota.get(provider),
	enabled = () => true,
	extra = {},
) {
	const handlers = new Map();
	const selected = [];
	const notices = [];
	let terminalInput;
	const cycleModels = extra.models ?? models;
	let current = cycleModels[0].model;
	let level = "low";
	const ctx = {
		mode: "tui",
		scopedModels: cycleModels,
		modelRegistry: { isUsingOAuth: () => extra.oauth ?? false },
		cwd: "/test",
		isProjectTrusted: () => true,
		get model() {
			return current;
		},
		ui: {
			onTerminalInput: (callback) => {
				terminalInput = callback;
				return () => {
					terminalInput = undefined;
				};
			},
			notify: (...args) => notices.push(args),
		},
	};
	const context = createContext({ Date, console, setTimeout });
	const module = new SourceTextModule(source, { context });
	const dependencies = {
		"@earendil-works/pi-coding-agent": {
			getAgentDir: () => "/agent",
			SettingsManager: {
				create: () => ({
					getModelThinkingLevel: () => undefined,
					getDefaultThinkingLevel: () => extra.defaultThinkingLevel,
				}),
			},
		},
		"@earendil-works/pi-tui": { getKeybindings: () => ({ matches: (data, action) => data === action }) },
		"./quota/provider-quota": {
			readProviderQuota: (provider) => readQuota(provider),
			isQuotaExhausted: (snapshot) =>
				hasRecentChatGPTLimit(snapshot?.chatgptLimitAt) ||
				(snapshot?.windows.some((w) => w.percent <= 0 && (!w.hasReset || w.resetSec > 0)) ?? false),
		},
		"./quota/quotas": { quotaKey },
	};
	await module.link(async (specifier) => {
		const exports = dependencies[specifier];
		assert.ok(exports, `unexpected import: ${specifier}`);
		return new SyntheticModule(
			Object.keys(exports),
			function () {
				for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
			},
			{ context },
		);
	});
	await module.evaluate();
	module.namespace.default(
		{
			on: (name, handler) => handlers.set(name, handler),
			getThinkingLevel: () => level,
			setModel: async (model) => {
				selected.push(model);
				current = model;
				await extra.afterSetModel?.();
				return true;
			},
			setThinkingLevel: (next) => {
				selected.push(next);
				level = next;
			},
		},
		{ enabled },
	);
	return {
		ctx,
		quota,
		selected,
		notices,
		get level() {
			return level;
		},
		setLevel: (next) => {
			level = next;
		},
		setCurrent: (model) => {
			current = model;
		},
		start: () => handlers.get("session_start")({}, ctx),
		stop: () => handlers.get("session_shutdown")(),
		input: (action) => terminalInput?.(action),
		select: (index, previous = cycleModels[0].model) => {
			current = cycleModels[index].model;
			return handlers.get("model_select")(
				{ source: "cycle", model: cycleModels[index].model, previousModel: previous },
				ctx,
			);
		},
	};
}

test("cycle skips known exhausted provider and preserves the candidate's thinking level without the footer", async () => {
	const h = await harness(
		new Map([
			["openai-codex", { windows: [window(50)] }],
			["zai", { windows: [window(0)] }],
			["opencode-go", { windows: [window(80)] }],
		]),
	);
	h.start();
	h.input("app.model.cycleForward");
	h.select(1);
	await settle();
	assert.deepEqual(h.selected, [models[2].model, "medium"]);
	// Info, so it replaces Pi's "Switched to b" status line instead of following it.
	assert.deepEqual(h.notices, [["Switched to c (thinking: medium); skipped zai/b (quota exhausted)", "info"]]);
	h.stop();
});

test("reverse cycle skips exhausted models in the configured direction", async () => {
	const h = await harness(
		new Map([
			["zai", { windows: [window(0)] }],
			["openai-codex", { windows: [window(80)] }],
		]),
	);
	h.start();
	h.input("app.model.cycleBackward");
	h.setLevel("high"); // pi applies the skipped model's scoped level before model_select
	h.select(1, models[2].model);
	await settle();
	// Like a direct cycle to a model without a scoped level: the pre-cycle level, not the skipped model's.
	assert.deepEqual(h.selected, [models[0].model, "low"]);
	assert.equal(h.level, "low");
	h.stop();
});

test("a configured default thinking level wins over the pre-cycle level after a skip", async () => {
	const h = await harness(
		new Map([
			["zai", { windows: [window(0)] }],
			["openai-codex", { windows: [window(80)] }],
		]),
		undefined,
		undefined,
		{ defaultThinkingLevel: "medium" },
	);
	h.start();
	h.input("app.model.cycleBackward");
	h.setLevel("high");
	h.select(1, models[2].model);
	await settle();
	assert.equal(h.level, "medium");
	h.stop();
});

test("a model chosen while the skip's model switch is pending is left alone", async () => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const h = await harness(
		new Map([
			["zai", { windows: [window(0)] }],
			["opencode-go", { windows: [window(80)] }],
		]),
		undefined,
		undefined,
		{ afterSetModel: () => gate },
	);
	h.start();
	h.input("app.model.cycleForward");
	h.select(1);
	await settle();
	// The user cycles on while pi is still running model_select handlers for the skip's switch.
	h.setCurrent(models[0].model);
	release();
	await settle();
	assert.deepEqual(h.selected, [models[2].model]);
	assert.deepEqual(h.notices, []);
	h.stop();
});

test("a cycle starts every scoped provider's quota read at once", async () => {
	const started = [];
	const gates = {};
	const quotas = new Map([
		["openai-codex", { windows: [window(80)] }],
		["zai", { windows: [window(0)] }],
		["opencode-go", { windows: [window(80)] }],
	]);
	const h = await harness(quotas, async (provider) => {
		started.push(provider);
		await new Promise((resolve) => {
			gates[provider] = resolve;
		});
		return quotas.get(provider);
	});
	h.start();
	h.input("app.model.cycleForward");
	h.select(1);
	await settle();
	// All three providers' reads started together; none waited for another.
	assert.deepEqual([...started].sort(), ["openai-codex", "opencode-go", "zai"]);
	for (const resolve of Object.values(gates)) resolve();
	await settle();
	assert.deepEqual(h.selected, [models[2].model, "medium"]);
	h.stop();
});

test("missing quota is not proof a model is unavailable", async () => {
	const h = await harness();
	h.start();
	h.select(1);
	await settle();
	assert.deepEqual(h.selected, []);
	assert.deepEqual(h.notices, []);
	h.stop();
});

test("a slow quota read does not override a newer model selection", async () => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const quota = new Map([
		["zai", { windows: [window(0)] }],
		["opencode-go", { windows: [window(80)] }],
	]);
	const h = await harness(quota, async (provider) => {
		if (provider === "zai") await gate;
		return quota.get(provider);
	});
	h.start();
	h.input("app.model.cycleForward");
	h.select(1);
	await settle();
	// The user keeps cycling while the first lookup is still pending.
	h.input("app.model.cycleForward");
	h.select(2, models[1].model);
	await settle();
	release();
	await settle();
	assert.deepEqual(h.selected, []);
	assert.equal(h.ctx.model, models[2].model);
	h.stop();
});

test("when every model is exhausted, the previous model and thinking level are restored", async () => {
	const exhausted = { windows: [window(0)] };
	const h = await harness(
		new Map([
			["openai-codex", exhausted],
			["zai", exhausted],
			["opencode-go", exhausted],
		]),
	);
	h.start();
	h.setLevel("xhigh");
	h.input("app.model.cycleForward");
	h.setLevel("high"); // pi applies the cycled model's scoped level before model_select
	h.select(1);
	await settle();
	assert.deepEqual(h.selected, [models[0].model, "xhigh"]);
	assert.equal(h.notices[0][1], "warning");
	assert.match(h.notices[0][0], /^No scoped model with available quota .*; staying on a\.$/);
	h.stop();
});

test("a slow quota read does not hold up Pi's cycle", async () => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const quota = new Map([
		["zai", { windows: [window(0)] }],
		["opencode-go", { windows: [window(80)] }],
	]);
	const h = await harness(quota, async (provider) => {
		await gate;
		return quota.get(provider);
	});
	h.start();
	h.input("app.model.cycleForward");
	// Pi awaits model_select handlers before it prints "Switched to …".
	assert.equal(h.select(1), undefined);
	await settle();
	assert.deepEqual(h.selected, []);
	release();
	await settle();
	assert.deepEqual(h.selected, [models[2].model, "medium"]);
	h.stop();
});

test("disabled skip leaves cycling alone and cancels a pending quota check", async () => {
	let enabled = true;
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const quotas = new Map([
		["zai", { windows: [window(0)] }],
		["opencode-go", { windows: [window(80)] }],
	]);
	const h = await harness(
		quotas,
		async (provider) => {
			if (provider === "zai") await gate;
			return quotas.get(provider);
		},
		() => enabled,
	);
	h.start();
	h.select(1);
	await settle();
	enabled = false;
	release();
	await settle();
	assert.deepEqual(h.selected, []);
	h.select(1);
	await settle();
	assert.deepEqual(h.selected, []);
	enabled = true;
	h.select(1);
	await settle();
	assert.deepEqual(h.selected, [models[2].model, "medium"]);
	h.stop();
});

test("a session change drops a pending skip check", async () => {
	const h = await harness(
		new Map([
			["zai", { windows: [window(0)] }],
			["opencode-go", { windows: [window(80)] }],
		]),
	);
	h.start();
	h.input("app.model.cycleForward");
	h.select(1);
	h.stop();
	await settle();
	assert.deepEqual(h.selected, []);
	assert.deepEqual(h.notices, []);
});

test("cycling directly onto a virtual model does not query or reject its namesake provider", async () => {
	const cycleModels = [models[0], { model: { provider: "openai-codex", id: "auto", api: "pi-virtual" } }, models[1]];
	let reads = 0;
	const h = await harness(
		undefined,
		async () => {
			reads++;
			return { windows: [window(0)] };
		},
		undefined,
		{ models: cycleModels },
	);
	h.start();
	h.select(1);
	await settle();
	assert.equal(reads, 0);
	assert.deepEqual(h.selected, []);
	assert.equal(h.ctx.model, cycleModels[1].model);
	h.stop();
});

test("a skip can land on a virtual model even when its namesake physical provider is exhausted", async () => {
	const virtual = { provider: "openai-codex", id: "auto", api: "pi-virtual" };
	const cycleModels = [models[0], { model: virtual, thinkingLevel: "high" }, models[1]];
	const h = await harness(new Map([["openai-codex", { windows: [window(0)] }]]), undefined, undefined, {
		models: cycleModels,
	});
	h.start();
	h.input("app.model.cycleForward");
	h.select(0, cycleModels[2].model);
	await settle();
	assert.deepEqual(h.selected, [virtual, "high"]);
	h.stop();
});

const chatgptLimit = (at = Date.now()) => [CHATGPT_QUOTA_KEY, { windows: [], chatgptLimitAt: at }];
for (const [name, oauth, cached, shouldSkip, baseUrl = "https://api.openai.com/v1"] of [
	["fresh ChatGPT app restriction", true, chatgptLimit(), true],
	["expired ChatGPT app restriction", true, chatgptLimit(Date.now() - 5 * 60_000), false],
	["API-key model with cached OAuth restriction", false, chatgptLimit(), false],
	["ordinary API-key token limit", false, ["openai", { windows: [window(0)] }], true],
	["ChatGPT model with cached API-key token limit", true, ["openai", { windows: [window(0)] }], false],
	["proxy model with cached OAuth restriction", true, chatgptLimit(), false, "https://proxy.example/v1"],
]) {
	test(`OpenAI cycling separates billing paths: ${name}`, async () => {
		const openai = { provider: "openai", id: "test", api: "openai-responses", baseUrl };
		const cycleModels = [models[0], { model: openai }, models[2]];
		const h = await harness(new Map([cached]), undefined, undefined, { models: cycleModels, oauth });
		h.start();
		h.select(1);
		await settle();
		assert.deepEqual(h.selected, shouldSkip ? [models[2].model, "medium"] : []);
		h.stop();
	});
}
