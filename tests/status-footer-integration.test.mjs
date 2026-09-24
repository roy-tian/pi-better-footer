import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const source = stripTypeScriptTypes(await readFile(new URL("../extensions/footer/index.ts", import.meta.url), "utf8"));
const deferred = () => {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
const window = (scope, percent) => ({ scope, percent, hasReset: false, resetSec: 0, capturedAt: Date.now() });

async function harness(provider = "zai", overrides = {}) {
	const handlers = new Map();
	const commands = new Map();
	const pending = [];
	let holder;
	const widgets = [];
	const fakeQuotas = {
		COPILOT_PROVIDER: "github-copilot",
		COPILOT_CREDITS_REFRESH_MS: 30000,
		compareRateWindows: () => 0,
		detectRateWindows: () => [],
		toRateWindows: (raw) => overrides.toRateWindows?.(raw) ?? [],
		parseLimitError: () => undefined,
		parseCodexUsageHeaders: () => [],
		isZaiProvider: (p) => p?.startsWith("zai") ?? false,
		isOpenCodeGoProvider: (p) => p === "opencode-go",
		readCodexRateLimits: () => overrides.readCodexRateLimits?.() ?? deferredRead(),
		readZaiRateLimits: () => overrides.readZaiRateLimits?.() ?? deferredRead(),
		readOpenCodeGoRateLimits: () => overrides.readOpenCodeGoRateLimits?.() ?? deferredRead(),
		readGitHubCopilotCredits: async () => undefined,
	};
	function deferredRead() {
		const task = deferred();
		pending.push(task);
		return task.promise;
	}
	const makeState = () => ({
		currentModelProvider: undefined,
		currentModelId: undefined,
		currentModelReasoning: false,
		thinkingLevel: "off",
		rateWindows: [],
		providerQuotas: new Map(),
		tokenSpeed: null,
		streamFirstDelta: null,
		streamFirstAnswerDelta: null,
		streamLastModelUpdate: null,
		gitAdded: 0,
		gitRemoved: 0,
		gitDirty: false,
		gitRefreshInFlight: false,
		gitRefreshQueued: false,
		gitCheckedLeafId: undefined,
		quotaPolls: new Map(),
		copilotCredits: undefined,
	});
	const git = { reads: 0, leaf: "leaf-0" };
	const dependencies = {
		"../quota/provider-quota": {
			rememberProviderQuota() {},
			async readProviderQuota(provider) {
				if (provider === "github-copilot") return undefined;
				const windows =
					provider === "openai-codex"
						? await fakeQuotas.readCodexRateLimits()
						: provider === "opencode-go"
							? await fakeQuotas.readOpenCodeGoRateLimits()
							: await fakeQuotas.readZaiRateLimits();
				return { windows, updatedAt: Date.now() };
			},
		},
		"../quota/quotas": fakeQuotas,
		"./state": { createState: makeState },
		"./render": {
			renderFooter(h) {
				holder = h;
				return [""];
			},
			renderProjectLine: () => "project",
		},
		"./git": {
			readGitChanges: () => {
				git.reads++;
				return overrides.readGitChanges?.() ?? Promise.resolve(undefined);
			},
		},
	};
	const clock = { now: 0 };
	const performance = { now: () => clock.now };
	// Wall clock for idle/poll timing; follows real time until a test sets it.
	const wall = { now: undefined };
	const RealDate = Date;
	class FakeDate extends RealDate {
		static now() {
			return wall.now ?? RealDate.now();
		}
	}
	let onTick;
	const setInterval = (fn) => {
		onTick = fn;
		return 1;
	};
	const context = createContext({
		setInterval,
		clearInterval() {},
		setTimeout,
		clearTimeout,
		console,
		process,
		performance,
		Date: FakeDate,
	});
	const module = new SourceTextModule(source, { context });
	await module.link(async (specifier) => {
		const exports = dependencies[specifier] ?? (await import(specifier));
		return new SyntheticModule(
			Object.keys(exports),
			function () {
				for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
			},
			{ context },
		);
	});
	await module.evaluate();
	const pi = {
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		getThinkingLevel: () => "low",
		exec: async () => ({ code: 1, stdout: "" }),
		setModel: async (model) => {
			selected.push(model);
			return true;
		},
		setThinkingLevel() {},
	};
	const selected = [];
	module.namespace.default(pi);
	const createCtx = (modelProvider = provider, models = []) => {
		const ctx = {
			mode: "tui",
			cwd: "/test",
			model: { provider: modelProvider, id: "test", reasoning: true },
			scopedModels: models,
			modelRegistry: { getApiKeyForProvider: async () => "test" },
			sessionManager: { getEntries: () => [], getCwd: () => "/test", getLeafId: () => git.leaf },
			ui: {
				setWidget: (key, factory, opts) => widgets.push({ key, factory, opts }),
				setFooter: (factory) => {
					if (factory)
						factory(
							{ requestRender() {} },
							{},
							{
								getGitBranch: () => "main",
								getExtensionStatuses: () => new Map(),
								onBranchChange: () => () => {},
							},
						).render(80);
				},
				onTerminalInput: () => () => {},
			},
		};
		return ctx;
	};
	const emit = async (event, payload, ctx) => handlers.get(event)?.(payload, ctx);
	return {
		createCtx,
		emit,
		pending,
		clock,
		wall,
		git,
		tick: () => onTick(),
		get state() {
			return holder.state;
		},
		widgets,
		selected,
		commands,
	};
}

test("footer does not register a separate command", async () => {
	const h = await harness();
	assert.equal(h.commands.size, 0);
});

for (const [provider, scope] of [
	["zai", "zai:3"],
	["openai-codex", "codex:primary"],
	["opencode-go", "opencode-go:5h"],
]) {
	test(`${provider} ignores an old quota response after session replacement`, async () => {
		const h = await harness(provider);
		const first = h.createCtx();
		await h.emit("session_start", {}, first);
		const earlier = h.pending.shift();
		const second = h.createCtx();
		await h.emit("session_start", {}, second);
		const later = h.pending.shift();
		assert.equal(h.widgets.at(-1).opts.placement, "aboveEditor");
		later.resolve([window(scope, 80)]);
		await later.promise;
		await new Promise(setImmediate);
		assert.equal(h.state.rateWindows[0].percent, 80);
		earlier.resolve([window(scope, 10)]);
		await earlier.promise;
		await new Promise(setImmediate);
		assert.equal(h.state.rateWindows[0].percent, 80);
		await h.emit("session_shutdown", {}, second);
	});
}

test("quota polling is throttled per provider and forced on a provider switch", async () => {
	const h = await harness("zai");
	const ctx = h.createCtx();
	await h.emit("session_start", {}, ctx);
	assert.equal(h.pending.length, 1);
	h.pending.shift().resolve([window("zai:3", 70)]);
	await new Promise(setImmediate);
	// A finished turn inside the poll interval does not refetch.
	await h.emit("message_end", { message: { role: "assistant", usage: { output: 1 } } }, ctx);
	assert.equal(h.pending.length, 0);
	// Another model from the same provider shares the account quota.
	await h.emit("model_select", { model: { provider: "zai", id: "other" } }, ctx);
	assert.equal(h.pending.length, 0);
	await h.emit("model_select", { model: { provider: "openai-codex", id: "gpt" } }, ctx);
	assert.equal(h.pending.length, 1);
	h.pending.shift().resolve([window("codex:primary", 40)]);
	await new Promise(setImmediate);
	assert.deepEqual(
		Array.from(h.state.rateWindows, (w) => w.percent),
		[40],
	);
	await h.emit("session_shutdown", {}, ctx);
});

test("print and json runs never poll account quota", async () => {
	const h = await harness("zai");
	const ctx = h.createCtx();
	ctx.mode = "print";
	await h.emit("session_start", {}, ctx);
	await h.emit("message_end", { message: { role: "assistant", usage: { output: 1 } } }, ctx);
	assert.equal(h.pending.length, 0);
	await h.emit("session_shutdown", {}, ctx);
});

test("rate-limit headers are only credited to the provider the request went to", async () => {
	const h = await harness("anthropic", { toRateWindows: () => [window("tokens", 0)] });
	const ctx = h.createCtx();
	await h.emit("session_start", {}, ctx);
	// The user switches models while the anthropic request is still in flight.
	await h.emit("before_provider_request", { payload: {} }, ctx);
	await h.emit("model_select", { model: { provider: "openai", id: "gpt" } }, ctx);
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows.length, 0);
	const openai = h.createCtx("openai");
	await h.emit("before_provider_request", { payload: {} }, openai);
	await h.emit("after_provider_response", { status: 200, headers: {} }, openai);
	assert.equal(h.state.rateWindows.length, 1);
	await h.emit("session_shutdown", {}, ctx);
});

test("git is re-read only when the working tree may have changed", async () => {
	const h = await harness("anthropic");
	const ctx = h.createCtx();
	await h.emit("session_start", {}, ctx);
	assert.equal(h.git.reads, 1);
	await new Promise(setImmediate);
	// An idle tick with no new session entry leaves git alone.
	h.tick();
	assert.equal(h.git.reads, 1);
	await h.emit("tool_execution_end", { toolName: "read" }, ctx);
	assert.equal(h.git.reads, 1);
	await h.emit("tool_execution_end", { toolName: "edit" }, ctx);
	assert.equal(h.git.reads, 2);
	await new Promise(setImmediate);
	// A `!` command has no event; its recorded result moves the session leaf.
	h.git.leaf = "leaf-1";
	h.tick();
	assert.equal(h.git.reads, 3);
	await new Promise(setImmediate);
	h.tick();
	assert.equal(h.git.reads, 3);
	await h.emit("agent_end", { messages: [] }, ctx);
	assert.equal(h.git.reads, 4);
	await new Promise(setImmediate);
	await h.emit("input", { text: "hi", source: "interactive" }, ctx);
	assert.equal(h.git.reads, 5);
	await h.emit("session_shutdown", {}, ctx);
});

test("a git refresh requested during a read runs once more afterwards", async () => {
	const reads = [];
	const h = await harness("anthropic", {
		readGitChanges: () => {
			const task = deferred();
			reads.push(task);
			return task.promise;
		},
	});
	const ctx = h.createCtx();
	await h.emit("session_start", {}, ctx);
	await h.emit("tool_execution_end", { toolName: "write" }, ctx);
	await h.emit("tool_execution_end", { toolName: "bash" }, ctx);
	assert.equal(reads.length, 1);
	reads.shift().resolve({ added: 1, removed: 0, dirty: true });
	await new Promise(setImmediate);
	assert.equal(reads.length, 1);
	reads.shift().resolve({ added: 2, removed: 0, dirty: true });
	await new Promise(setImmediate);
	assert.equal(reads.length, 0);
	assert.equal(h.state.gitAdded, 2);
	await h.emit("session_shutdown", {}, ctx);
});

test("print runs never read git", async () => {
	const h = await harness("anthropic");
	const ctx = h.createCtx();
	ctx.mode = "print";
	await h.emit("session_start", {}, ctx);
	await h.emit("tool_execution_end", { toolName: "edit" }, ctx);
	await h.emit("agent_end", { messages: [] }, ctx);
	assert.equal(h.git.reads, 0);
});

test("quota polling backs off to 10 minutes, then an hour, while Pi is idle", async () => {
	const h = await harness("zai");
	const ctx = h.createCtx();
	const minute = 60_000;
	const t0 = 1_000_000_000;
	const settle = async () => {
		h.pending.shift().resolve([window("zai:3", 70)]);
		await new Promise(setImmediate);
	};
	const at = (offset) => {
		h.wall.now = t0 + offset;
		h.tick();
	};
	h.wall.now = t0;
	await h.emit("session_start", {}, ctx);
	await settle();
	// In use: the normal 60s cadence.
	at(61_000);
	assert.equal(h.pending.length, 1);
	await settle();
	// Idle for 10+ minutes: every 10 minutes.
	at(11 * minute);
	assert.equal(h.pending.length, 0);
	at(12 * minute);
	assert.equal(h.pending.length, 1);
	await settle();
	// Idle for an hour+: hourly.
	at(71 * minute);
	assert.equal(h.pending.length, 0);
	at(72 * minute + 1000);
	assert.equal(h.pending.length, 1);
	await settle();
	// Coming back refreshes right away and restores the normal cadence.
	h.wall.now = t0 + 80 * minute;
	await h.emit("input", { text: "hi", source: "interactive" }, ctx);
	assert.equal(h.pending.length, 1);
	await settle();
	at(80 * minute + 61_000);
	assert.equal(h.pending.length, 1);
	await settle();
	await h.emit("session_shutdown", {}, ctx);
});

test("token speed starts at the first streamed token and leaves out hidden reasoning", async () => {
	const h = await harness("anthropic");
	const ctx = h.createCtx();
	await h.emit("session_start", {}, ctx);
	const assistant = (usage) => ({ role: "assistant", usage });
	const stream = async (events, usage) => {
		await h.emit("message_start", { message: assistant() }, ctx);
		for (const [at, type] of events) {
			h.clock.now = at;
			await h.emit("message_update", { message: assistant(), assistantMessageEvent: { type } }, ctx);
		}
		await h.emit("message_end", { message: assistant(usage) }, ctx);
		return h.state.tokenSpeed;
	};

	// 3s before the first token is prompt processing, not output speed.
	h.clock.now = 0;
	assert.equal(
		await stream(
			[
				[3000, "text_start"],
				[3000, "text_delta"],
				[5000, "text_delta"],
				[5000, "text_end"],
			],
			{ output: 100 },
		),
		50,
	);
	// Streamed thinking without a reasoning breakdown counts from the first thinking token.
	h.clock.now = 10_000;
	assert.equal(
		await stream(
			[
				[11_000, "thinking_delta"],
				[13_000, "text_delta"],
				[15_000, "text_delta"],
			],
			{ output: 200 },
		),
		50,
	);
	// Reported reasoning tokens are left out along with the time before the answer began.
	h.clock.now = 20_000;
	assert.equal(
		await stream(
			[
				[21_000, "thinking_delta"],
				[28_000, "text_delta"],
				[30_000, "text_delta"],
			],
			{ output: 1100, reasoning: 1000 },
		),
		50,
	);
	// A reply with no measurable stream keeps the previous reading.
	assert.equal(await stream([], { output: 10 }), 50);
	await h.emit("session_shutdown", {}, ctx);
});

async function loadRender() {
	const renderSource = stripTypeScriptTypes(
		await readFile(new URL("../extensions/footer/render.ts", import.meta.url), "utf8"),
	);
	const context = createContext({ process, console });
	const module = new SourceTextModule(renderSource, { context });
	const dependencies = {
		"@earendil-works/pi-tui": {
			visibleWidth: (text) => text.length,
			truncateToWidth: (text, width) => text.slice(0, Math.max(0, width)),
		},

		"./session-stats": {
			summarizeSessionUsage: () => ({
				totals: { input: 1200, output: 200, cacheRead: 500, cacheWrite: 0 },
				latestHit: 29.4,
			}),
		},
		"../quota/quotas": { COPILOT_PROVIDER: "github-copilot" },
	};
	await module.link(async (specifier) => {
		const exports = dependencies[specifier] ?? (specifier.startsWith("node:") ? await import(specifier) : undefined);
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
	return module;
}

test("the project path abbreviates HOME only at a real path boundary", async (t) => {
	const module = await loadRender();
	const oldHome = process.env.HOME;
	t.after(() => {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
	});
	const project = (home, cwd) => {
		process.env.HOME = home;
		const h = {
			state: { gitDirty: false },
			ctx: { sessionManager: { getCwd: () => cwd } },
			footerData: { getGitBranch: () => null },
		};
		return module.namespace.renderProjectLine(h, 200).trim();
	};
	assert.equal(project("/home/u", "/home/u/proj"), "~/proj");
	assert.equal(project("/home/u/", "/home/u/proj"), "~/proj");
	assert.equal(project("/home/u/", "/home/u"), "~");
	assert.equal(project("/home/u", "/home/user/proj"), "/home/user/proj");
	assert.equal(project("/", "/workspace/app"), "/workspace/app");
});

test("footer fits narrow terminal widths without losing the model prefix", async () => {
	const module = await loadRender();
	const h = {
		state: {
			currentModelProvider: "openai-codex",
			currentModelId: "test-model",
			currentModelReasoning: true,
			thinkingLevel: "high",
			rateWindows: [window("codex:primary", 80)],
			tokenSpeed: 20,
		},
		ctx: {
			sessionManager: { getEntries: () => [] },
			getContextUsage: () => ({ tokens: 50000, percent: 50, contextWindow: 100000 }),
		},
		footerData: { getExtensionStatuses: () => new Map() },
	};
	for (const width of [80, 32, 18, 8, 1]) {
		const [line] = module.namespace.renderFooter(h, width);
		assert.ok(line.length <= width, `${width}: ${line}`);
		assert.ok(line.length > 0);
		if (width === 80) assert.ok(line.startsWith("openai-codex/test-model"));
	}

	h.theme = { name: "dark", fg: (color, text) => `<${color}:${text}>`, bold: (text) => text };
	const [normal] = module.namespace.renderFooter(h, 500);
	assert.match(normal, /<accent:↑><muted:1\.2k>/);
	assert.match(normal, /<accent:↓><muted:200>/);
	assert.match(normal, /<accent:CH><muted:29\.4%>/);
	assert.match(normal, /<accent:50k>/);

	h.ctx.getContextUsage = () => ({ tokens: 80000, percent: 80, contextWindow: 100000 });
	const [warning] = module.namespace.renderFooter(h, 500);
	assert.match(warning, /<warning:↑><muted:1\.2k>/);
	assert.match(warning, /<warning:↓><muted:200>/);
	assert.match(warning, /<warning:CH><muted:29\.4%>/);
	assert.match(warning, /<warning:80k>/);

	h.ctx.getContextUsage = () => ({ tokens: 95000, percent: 95, contextWindow: 100000 });
	const [error] = module.namespace.renderFooter(h, 500);
	assert.match(error, /<error:↑><muted:1\.2k>/);
	assert.match(error, /<error:↓><muted:200>/);
	assert.match(error, /<error:CH><muted:29\.4%>/);
	assert.match(error, /<error:95k>/);
});
