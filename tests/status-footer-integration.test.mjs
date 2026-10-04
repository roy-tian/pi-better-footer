import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { CHATGPT_QUOTA_KEY, CHATGPT_USAGE_URL, hasRecentChatGPTLimit, quotaKey } from "../extensions/quota/openai.ts";

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
	const providerQuotas = new Map();
	const fakeQuotas = {
		CHATGPT_QUOTA_KEY,
		quotaKey,
		COPILOT_PROVIDER: "github-copilot",
		COPILOT_CREDITS_REFRESH_MS: 30000,
		compareRateWindows: () => 0,
		detectRateWindows: () => [],
		toRateWindows: (raw) => overrides.toRateWindows?.(raw) ?? [],
		parseLimitError: (error) => overrides.parseLimitError?.(error),
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
		currentQuotaKey: undefined,
		thinkingLevel: "off",
		rateWindows: [],
		providerQuotas,
		tokenSpeed: null,
		streamFirstDelta: null,
		streamFirstAnswerDelta: null,
		streamLastModelUpdate: null,
		streamHasToolCall: false,
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
			rememberProviderQuota(provider, update) {
				providerQuotas.set(provider, {
					windows: [],
					...providerQuotas.get(provider),
					...update,
					updatedAt: Date.now(),
				});
			},
			async readProviderQuota(provider) {
				if (provider === "openai") return providerQuotas.get(provider);
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
			modelRegistry: {
				getApiKeyForProvider: async () => "test",
				isUsingOAuth: () => overrides.oauth ?? false,
			},
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
	// An aborted reply's error event lands when the user presses Esc, well after
	// the last token; the stall before the abort is not generation time.
	h.clock.now = 30_000;
	assert.equal(
		await stream(
			[
				[31_000, "text_delta"],
				[32_000, "text_delta"],
				[36_000, "error"],
			],
			{ output: 100 },
		),
		100,
	);
	// A reply with no measurable stream keeps the previous reading.
	assert.equal(await stream([], { output: 10 }), 100);
	await h.emit("session_shutdown", {}, ctx);
});

test("token speed skips tool-call replies and resumes on the next text reply", async () => {
	const h = await harness("anthropic");
	const ctx = h.createCtx();
	await h.emit("session_start", {}, ctx);
	const assistant = (extra = {}) => ({ role: "assistant", ...extra });
	const update = async (type, at) => {
		h.clock.now = at;
		await h.emit("message_update", { message: assistant(), assistantMessageEvent: { type } }, ctx);
	};

	for (const kind of ["toolcall_start", "toolcall_delta", "toolcall_end", "final-content", "tool-only"]) {
		await h.emit("message_start", { message: assistant() }, ctx);
		if (kind !== "tool-only") {
			await update("text_delta", 1000);
			await update("text_delta", 2000);
		}
		if (kind !== "final-content") {
			await update(kind === "tool-only" ? "toolcall_delta" : kind, 3000);
			await update(kind === "tool-only" ? "toolcall_delta" : "text_delta", 4000);
		}
		await h.emit(
			"message_end",
			{
				message: assistant({
					usage: { output: 1200 },
					// Final content is authoritative even when no tool-call event was seen.
					content: kind === "final-content" ? [{ type: "toolCall" }] : [],
				}),
			},
			ctx,
		);
		assert.equal(h.state.tokenSpeed, kind === "toolcall_start" ? null : 50, kind);
		assert.equal(h.state.streamHasToolCall, false);

		// A tool reply must not prevent a subsequent ordinary reply from updating t/s.
		await h.emit("message_start", { message: assistant() }, ctx);
		await update("text_delta", 5000);
		await update("text_delta", 7000);
		await h.emit("message_end", { message: assistant({ usage: { output: 100 } }) }, ctx);
		assert.equal(h.state.tokenSpeed, 50);
	}
	await h.emit("session_shutdown", {}, ctx);
});

test("CLI output and tool results do not change model timing or speed", async () => {
	const h = await harness("anthropic");
	const ctx = h.createCtx();
	await h.emit("session_start", {}, ctx);
	await h.emit("message_start", { message: { role: "assistant" } }, ctx);
	for (const at of [1000, 3000]) {
		h.clock.now = at;
		await h.emit(
			"message_update",
			{ message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } },
			ctx,
		);
	}
	h.clock.now = 9000;
	for (const role of ["toolResult", "bashExecution", "custom"]) {
		const message = { role, usage: { output: 10000 }, content: "CLI output" };
		await h.emit("message_start", { message }, ctx);
		await h.emit("message_update", { message, assistantMessageEvent: { type: "text_delta" } }, ctx);
		await h.emit("message_end", { message }, ctx);
	}
	await h.emit("tool_execution_update", { toolName: "bash", partialResult: { content: "CLI output" } }, ctx);
	assert.equal(h.state.streamFirstDelta, 1000);
	assert.equal(h.state.streamLastModelUpdate, 3000);
	assert.equal(h.state.tokenSpeed, null);
	await h.emit("message_end", { message: { role: "assistant", usage: { output: 100 } } }, ctx);
	assert.equal(h.state.tokenSpeed, 50);
	await h.emit("session_shutdown", {}, ctx);
});

async function loadRender() {
	const renderSource = stripTypeScriptTypes(
		await readFile(new URL("../extensions/footer/render.ts", import.meta.url), "utf8"),
	);
	const context = createContext({ process, console });
	const module = new SourceTextModule(renderSource, { context });
	const sessionStats = {
		totals: { input: 1200, output: 200, cacheRead: 500, cacheWrite: 0, cost: 0.1234 },
		latestHit: 29.4,
	};
	const dependencies = {
		"@earendil-works/pi-tui": {
			visibleWidth: (text) => text.length,
			truncateToWidth: (text, width) => text.slice(0, Math.max(0, width)),
		},

		"./session-stats": { summarizeSessionUsage: () => sessionStats },
		"../quota/quotas": {
			COPILOT_PROVIDER: "github-copilot",
			CHATGPT_QUOTA_KEY,
			CHATGPT_USAGE_URL,
			hasRecentChatGPTLimit,
		},
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
	return { namespace: module.namespace, sessionStats };
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
	// The session cost keeps pi's own footer format, accent $ and muted amount.
	assert.match(error, /<error:\$><muted:0\.123>/);
});

test("session cost sits left of the context segment and hides when unpriced", async () => {
	const module = await loadRender();
	const h = {
		state: {
			currentModelProvider: "anthropic",
			currentModelId: "claude",
			currentModelReasoning: false,
			thinkingLevel: "off",
			rateWindows: [],
			tokenSpeed: null,
		},
		ctx: {
			sessionManager: { getEntries: () => [] },
			getContextUsage: () => ({ tokens: 50000, percent: 50, contextWindow: 100000 }),
		},
		footerData: { getExtensionStatuses: () => new Map() },
		theme: { name: "dark", fg: (color, text) => `<${color}:${text}>`, bold: (text) => text },
	};
	const [line] = module.namespace.renderFooter(h, 500);
	assert.match(line, /<accent:\$><muted:0\.123>/);
	// Between the cache-hit stat and the context-window segment.
	assert.ok(line.indexOf("<accent:$>") > line.indexOf("<accent:CH>"));
	assert.ok(line.indexOf("<accent:$>") < line.indexOf("<accent:50k>"));
	// Subscription-backed models never report a cost; nothing stands in for one.
	module.sessionStats.totals.cost = 0;
	const [noCost] = module.namespace.renderFooter(h, 500);
	assert.doesNotMatch(noCost, /\$/);
});

test("the Z.AI monthly tool quota is marked with a hammer in the label color", async () => {
	const module = await loadRender();
	const at = Date.now();
	const h = {
		state: {
			currentModelProvider: "zai-coding-cn",
			currentModelId: "glm-4.7",
			currentModelReasoning: false,
			thinkingLevel: "off",
			rateWindows: [
				{ scope: "zai:3", percent: 40, hasReset: true, resetSec: 2.5 * 3600, capturedAt: at },
				{ scope: "zai:6", percent: 60, hasReset: true, resetSec: 6.5 * 86400, capturedAt: at },
				{ scope: "zai:monthly", percent: 97, hasReset: false, resetSec: 0, capturedAt: at },
			],
			tokenSpeed: null,
		},
		ctx: {
			sessionManager: { getEntries: () => [] },
			getContextUsage: () => ({ tokens: 50000, percent: 50, contextWindow: 100000 }),
		},
		footerData: { getExtensionStatuses: () => new Map() },
		theme: { name: "dark", fg: (color, text) => `<${color}:${text}>`, bold: (text) => text },
	};
	const [line] = module.namespace.renderFooter(h, 500);
	assert.match(line, /<dim:2h> <muted:40%>/);
	assert.match(line, /<dim:6d> <muted:60%>/);
	// nf-fa-hammer (U+EEFF) shares the countdown-label color on both themes.
	assert.match(line, /<dim:\uEEFF> <muted:97%>/);
	h.theme = { name: "light", fg: (color, text) => `<${color}:${text}>`, bold: (text) => text };
	const [light] = module.namespace.renderFooter(h, 500);
	assert.match(light, /<accent:2h> <muted:40%>/);
	assert.match(light, /<accent:\uEEFF> <muted:97%>/);
});

test("system appearance overrides missing or stale COLORFGBG and follows live theme changes", async (t) => {
	const old = process.env.COLORFGBG;
	t.after(() => {
		if (old === undefined) delete process.env.COLORFGBG;
		else process.env.COLORFGBG = old;
	});
	const module = await loadRender();
	const h = {
		state: {
			currentModelProvider: "test",
			currentModelId: "model",
			rateWindows: [{ ...window("tokens", 25), hasReset: true, resetSec: 3700 }],
		},
		ctx: {
			sessionManager: {},
			getContextUsage: () => ({ tokens: 80000, percent: 80, contextWindow: 100000 }),
		},
		theme: { name: "system", appearance: "light", fg: (color, text) => `<${color}:${text}>` },
	};
	for (const env of [undefined, "0;0"]) {
		if (env === undefined) delete process.env.COLORFGBG;
		else process.env.COLORFGBG = env;
		const [light] = module.namespace.renderFooter(h, 1000);
		assert.match(light, /<accent:1h> <syntaxFunction:25%>/);
		assert.ok(light.includes("\x1b[38;2;194;65;12m80k"));
		assert.ok(light.includes("\x1b[38;2;154;154;154m500"));
	}
	process.env.COLORFGBG = "0;15";
	h.theme.appearance = "dark";
	h.theme.name = "custom-light-name"; // Explicit appearance even wins over the name.
	const [dark] = module.namespace.renderFooter(h, 1000);
	assert.match(dark, /<dim:1h> <warning:25%>/);
	assert.match(dark, /<warning:80k>/);
	assert.ok(dark.includes("\x1b[38;2;144;144;144m500"));
});

test("OpenAI ChatGPT shows neither API headers nor a Codex poll", async () => {
	const h = await harness("openai", { oauth: true, toRateWindows: () => [window("tokens", 0)] });
	const ctx = h.createCtx();
	Object.assign(ctx.model, { api: "openai-responses", baseUrl: "https://api.openai.com/v1" });
	await h.emit("session_start", {}, ctx);
	assert.equal(h.state.currentQuotaKey, CHATGPT_QUOTA_KEY);
	assert.equal(h.pending.length, 0);
	await h.emit("before_provider_request", {}, ctx);
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows.length, 0);
	assert.equal(h.state.providerQuotas.size, 0);
	// Limits are recorded by the quota layer (trackChatGPTLimits), not the footer.
	await h.emit(
		"message_end",
		{ message: { role: "assistant", provider: "openai", errorMessage: "subscription_sharing_usage_limit_exceeded" } },
		ctx,
	);
	assert.equal(h.state.providerQuotas.size, 0);
	h.tick();
	assert.equal(h.pending.length, 0);
	await h.emit("session_shutdown", {}, ctx);
});

test("a /login or /logout moves the footer to the other OpenAI account without a model switch", async () => {
	let percent = 0;
	const h = await harness("openai", {
		toRateWindows: () => {
			percent += 10;
			return [window("tokens", percent)];
		},
	});
	const ctx = h.createCtx();
	Object.assign(ctx.model, { api: "openai-responses", baseUrl: "https://api.openai.com/v1" });
	await h.emit("session_start", {}, ctx);
	await h.emit("before_provider_request", {}, ctx);
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.currentQuotaKey, "openai");
	assert.equal(h.state.rateWindows.length, 1);
	ctx.modelRegistry.isUsingOAuth = () => true;
	h.tick();
	assert.equal(h.state.currentQuotaKey, CHATGPT_QUOTA_KEY);
	assert.equal(h.state.rateWindows.length, 0);
	// A request sent after /login belongs to the ChatGPT account, whose headers are not shown.
	await h.emit("before_provider_request", {}, ctx);
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows.length, 0);
	ctx.modelRegistry.isUsingOAuth = () => false;
	h.tick();
	assert.equal(h.state.currentQuotaKey, "openai");
	assert.equal(h.state.rateWindows[0].percent, 10); // The API-key account's cached windows return.
	// The note from before /logout belongs to the ChatGPT account.
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows[0].percent, 10);
	assert.equal(h.state.providerQuotas.get("openai").windows[0].percent, 10);
	await h.emit("session_shutdown", {}, ctx);
});

test("overlapping requests under one selection are both credited", async () => {
	let percent = 0;
	const h = await harness("anthropic", {
		toRateWindows: () => {
			percent += 10;
			return [window("tokens", percent)];
		},
	});
	const ctx = h.createCtx();
	await h.emit("session_start", {}, ctx);
	// A cache-warming request overlaps the main one; both answer afterwards.
	await h.emit("before_provider_request", {}, ctx);
	await h.emit("before_provider_request", {}, ctx);
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows[0].percent, 20);
	assert.equal(h.state.providerQuotas.get("anthropic").windows[0].percent, 20);
	await h.emit("session_shutdown", {}, ctx);
});

test("ChatGPT rendering links to usage without a fake balance or reset countdown", async () => {
	const module = await loadRender();
	const quotas = new Map();
	const h = {
		state: {
			currentModelProvider: "openai",
			currentModelId: "model",
			currentQuotaKey: CHATGPT_QUOTA_KEY,
			providerQuotas: quotas,
			rateWindows: [],
		},
	};
	const render = () => module.namespace.renderFooter(h, 1000)[0];
	assert.ok(render().includes(CHATGPT_USAGE_URL));
	assert.ok(render().includes("ChatGPT"));
	assert.ok(!render().includes("ChatGPT limit"));
	quotas.set(CHATGPT_QUOTA_KEY, { chatgptLimitAt: Date.now() });
	assert.ok(render().includes("ChatGPT limit"));
	assert.doesNotMatch(render(), /0%|5h|0s/);
	quotas.set(CHATGPT_QUOTA_KEY, { chatgptLimitAt: Date.now() - 5 * 60_000 });
	assert.ok(!render().includes("ChatGPT limit"));
	h.state.currentQuotaKey = "openai";
	assert.ok(!render().includes(CHATGPT_USAGE_URL));
});

test("virtual selections never poll their namesake provider and drop pending physical quota", async () => {
	const h = await harness("openai-codex");
	const ctx = h.createCtx();
	ctx.model.api = "pi-virtual";
	await h.emit("session_start", {}, ctx);
	assert.equal(h.pending.length, 0);
	assert.equal(h.state.currentQuotaKey, undefined);
	h.tick();
	assert.equal(h.pending.length, 0);
	ctx.model = { ...ctx.model, api: "openai-codex-responses", id: "physical" };
	await h.emit("model_select", { model: ctx.model }, ctx);
	assert.equal(h.pending.length, 1);
	const pending = h.pending.shift();
	ctx.model = { ...ctx.model, api: "pi-virtual", id: "auto" };
	await h.emit("model_select", { model: ctx.model }, ctx);
	pending.resolve([window("codex:primary", 0)]);
	await new Promise(setImmediate);
	assert.equal(h.state.rateWindows.length, 0);
	await h.emit("session_shutdown", {}, ctx);
});

test("OpenAI API-key and ChatGPT switches clear displayed limits and ignore the previous billing path's headers", async () => {
	const h = await harness("openai", { oauth: true, toRateWindows: () => [window("tokens", 0)] });
	const ctx = h.createCtx();
	Object.assign(ctx.model, { api: "openai-responses", baseUrl: "https://api.openai.com/v1" });
	ctx.modelRegistry.isUsingOAuth = () => false;
	await h.emit("session_start", {}, ctx);
	await h.emit("before_provider_request", {}, ctx);
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows.length, 1);
	await h.emit("before_provider_request", {}, ctx);
	ctx.modelRegistry.isUsingOAuth = () => true;
	await h.emit("model_select", { model: ctx.model }, ctx);
	assert.equal(h.state.rateWindows.length, 0);
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows.length, 0);
	await h.emit("before_provider_request", {}, ctx);
	ctx.modelRegistry.isUsingOAuth = () => false;
	await h.emit("model_select", { model: ctx.model }, ctx);
	h.state.rateWindows = [];
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows.length, 0);
	await h.emit("session_shutdown", {}, ctx);
});

test("an old session's response headers never populate a new session on the same provider", async () => {
	const h = await harness("anthropic", { toRateWindows: () => [window("tokens", 0)] });
	const first = h.createCtx();
	await h.emit("session_start", {}, first);
	await h.emit("before_provider_request", {}, first);
	const second = h.createCtx();
	await h.emit("session_start", {}, second);
	await h.emit("after_provider_response", { status: 200, headers: {} }, second);
	assert.equal(h.state.rateWindows.length, 0);
	await h.emit("session_shutdown", {}, second);
});

test("virtual ZAI selections do not replay or cache their namesake physical quota errors", async () => {
	const h = await harness("zai", { parseLimitError: () => window("zai:3", 0) });
	const ctx = h.createCtx();
	ctx.model.api = "pi-virtual";
	ctx.sessionManager.getEntries = () => [
		{ type: "message", message: { role: "assistant", provider: "zai", errorMessage: "429 quota error" } },
	];
	await h.emit("session_start", {}, ctx);
	await h.emit(
		"message_end",
		{ message: { role: "assistant", provider: "zai", errorMessage: "429 quota error" } },
		ctx,
	);
	assert.equal(h.state.rateWindows.length, 0);
	assert.equal(h.state.providerQuotas.has("zai"), false);
	assert.equal(h.pending.length, 0);
	await h.emit("session_shutdown", {}, ctx);
});

test("same-provider physical and virtual switches never misattribute response headers", async () => {
	const h = await harness("anthropic", { toRateWindows: () => [window("tokens", 0)] });
	const ctx = h.createCtx();
	ctx.model.api = "pi-virtual";
	await h.emit("session_start", {}, ctx);
	await h.emit("before_provider_request", {}, ctx);
	ctx.model = { ...ctx.model, api: "anthropic-messages", id: "physical" };
	await h.emit("model_select", { model: ctx.model }, ctx);
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows.length, 0);
	assert.equal(h.state.providerQuotas.has("anthropic"), false);
	// Nor may a second response to the request sent under the virtual selection.
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows.length, 0);
	await h.emit("before_provider_request", {}, ctx);
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows.length, 1);
	await h.emit("before_provider_request", {}, ctx);
	ctx.model = { ...ctx.model, api: "pi-virtual", id: "auto" };
	await h.emit("model_select", { model: ctx.model }, ctx);
	await h.emit("after_provider_response", { status: 200, headers: {} }, ctx);
	assert.equal(h.state.rateWindows.length, 0);
	await h.emit("session_shutdown", {}, ctx);
});
