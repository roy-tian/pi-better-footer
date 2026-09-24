import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const source = stripTypeScriptTypes(await readFile(new URL("../extensions/recent-model.ts", import.meta.url), "utf8"));
const modelA = { provider: "test", id: "a", reasoning: true };
const modelB = { provider: "test", id: "b", reasoning: true };
const plainModel = { provider: "test", id: "plain", reasoning: false };
const saved = (thinkingLevel = "high", model = modelB) => ({
	version: 1,
	provider: model.provider,
	modelId: model.id,
	thinkingLevel,
	updatedAt: 1,
});

async function harness(t, options = {}) {
	const dir = await mkdtemp(join(tmpdir(), "recent-model-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const cwd = "/test/project";
	const path = join(dir, "recent-models", `${createHash("sha256").update(resolve(cwd)).digest("hex")}.json`);
	if (options.state !== undefined) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(options.state));
	}
	const handlers = new Map();
	const notifications = [];
	const errors = [];
	const calls = [];
	let model = options.model ?? modelA;
	let level = options.level ?? "low";
	const ctx = {
		cwd,
		hasUI: options.hasUI ?? true,
		get model() {
			return model;
		},
		scopedModels: (options.scoped ?? []).map((entry) => (entry.model ? entry : { model: entry })),
		sessionManager: { getBranch: () => (options.conversation ? [{ type: "message" }] : []) },
		modelRegistry: {
			find: (provider, id) =>
				(options.models ?? [modelA, modelB, plainModel]).find((m) => m.provider === provider && m.id === id),
		},
		ui: { notify: (...args) => notifications.push(args) },
	};
	const emit = (name, event = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
	const pi = {
		registerFlag() {},
		getFlag: () => options.disabled ?? false,
		on: (name, handler) => handlers.set(name, handler),
		getThinkingLevel: () => level,
		setThinkingLevel(next) {
			calls.push(["thinking", next]);
			const previousLevel = level;
			level = model?.reasoning ? next : "off";
			if (level !== previousLevel) void emit("thinking_level_select", { level, previousLevel });
		},
		async setModel(next) {
			calls.push(["model", next.id]);
			if (options.auth === false) return false;
			if (options.auth === "throw") throw new Error("No API key");
			const previousModel = model;
			model = next;
			pi.setThinkingLevel("medium");
			await emit("model_select", { model, previousModel, source: "set" });
			return true;
		},
	};
	const context = createContext({
		process: { argv: ["node", "pi", ...(options.args ?? [])], pid: process.pid },
		console: { error: (...args) => errors.push(args), warn: (...args) => notifications.push(args) },
	});
	const module = new SourceTextModule(source, { context });
	await module.link(async (specifier) => {
		const exports =
			specifier === "@earendil-works/pi-coding-agent" ? { getAgentDir: () => dir } : await import(specifier);
		return new SyntheticModule(
			Object.keys(exports),
			function () {
				for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
			},
			{ context },
		);
	});
	await module.evaluate();
	module.namespace.default(pi, { enabled: () => options.enabled?.() ?? true });
	return {
		pi,
		emit,
		calls,
		notifications,
		errors,
		path,
		get model() {
			return model;
		},
		get level() {
			return level;
		},
		start: (reason = "startup") => emit("session_start", { reason }),
		shutdown: () => emit("session_shutdown", { reason: "quit" }),
		state: async () => JSON.parse(await readFile(path, "utf8")),
	};
}

for (const reason of ["startup", "new"]) {
	test(`${reason} restores model then thinking effort`, async (t) => {
		const h = await harness(t, { state: saved("xhigh") });
		await h.start(reason);
		assert.equal(h.model.id, "b");
		assert.equal(h.level, "xhigh");
		assert.deepEqual(h.calls, [
			["model", "b"],
			["thinking", "medium"],
			["thinking", "xhigh"],
		]);
		assert.equal((await h.state()).thinkingLevel, "xhigh");
		assert.equal(h.errors.length, 0);
	});
}

for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
	test(`same model restores ${level} without switching models`, async (t) => {
		const h = await harness(t, { state: saved(level, modelA), level: "medium" });
		await h.start();
		assert.equal(h.level, level);
		assert.equal(
			h.calls.some((call) => call[0] === "model"),
			false,
		);
		assert.equal((await h.state()).thinkingLevel, level);
	});
}

test("thinking-only changes persist immediately and shutdown flushes rapid changes", async (t) => {
	const h = await harness(t);
	await h.emit("thinking_level_select", { level: "high", previousLevel: "low" });
	assert.equal((await h.state()).thinkingLevel, "high");
	for (const level of ["max", "low", "high", "off", "xhigh"]) h.pi.setThinkingLevel(level);
	await h.shutdown();
	const state = await h.state();
	assert.equal(state.modelId, "a");
	assert.equal(state.thinkingLevel, "xhigh");
	assert.deepEqual(await readdir(dirname(h.path)), [h.path.split("/").at(-1)]);
});

test("model changes save their effective thinking level", async (t) => {
	const h = await harness(t, { level: "max" });
	await h.pi.setModel(modelB);
	assert.equal((await h.state()).thinkingLevel, "medium");
	assert.equal((await h.state()).modelId, "b");
});

for (const thinkingLevel of [undefined, "invalid", null, 5]) {
	test(`legacy/invalid thinking ${thinkingLevel} preserves model restoration`, async (t) => {
		const h = await harness(t, { state: saved(thinkingLevel) });
		if (thinkingLevel === undefined) {
			const state = saved();
			delete state.thinkingLevel;
			await writeFile(h.path, JSON.stringify(state));
		}
		await h.start();
		assert.equal(h.model.id, "b");
		assert.equal(h.level, "medium");
		assert.equal((await h.state()).thinkingLevel, "medium");
	});
}

for (const reason of ["reload", "resume", "fork"]) {
	test(`${reason} preserves current session settings`, async (t) => {
		const h = await harness(t, { state: saved("max") });
		await h.start(reason);
		assert.deepEqual(h.calls, []);
	});
}

for (const options of [
	{ disabled: true },
	{ conversation: true },
	{ args: ["--model", "test/a:low"] },
	{ args: ["--model=test/a:low"] },
	{ args: ["--provider", "test"] },
	{ args: ["--provider=test"] },
]) {
	test(`startup respects restore exclusions ${JSON.stringify(options)}`, async (t) => {
		const h = await harness(t, { ...options, state: saved("max") });
		await h.start();
		assert.deepEqual(h.calls, []);
		assert.equal(h.level, "low");
	});
}

for (const args of [["--thinking", "off"], ["--thinking=max"]]) {
	test(`explicit thinking wins while restoring model: ${args}`, async (t) => {
		const h = await harness(t, { args, state: saved("high") });
		await h.start();
		assert.equal(h.model.id, "b");
		assert.equal(h.level, args.length === 2 ? "off" : "max");
	});
}

test("/new ignores original startup thinking override", async (t) => {
	const h = await harness(t, { args: ["--thinking=off"], state: saved("max") });
	await h.start("new");
	assert.equal(h.level, "max");
});

test("arguments after -- do not override restoration", async (t) => {
	const h = await harness(t, { args: ["--", "--model=a", "--thinking=off"], state: saved("max") });
	await h.start();
	assert.equal(h.model.id, "b");
	assert.equal(h.level, "max");
});

for (const options of [{ models: [modelA] }, { auth: false }, { auth: "throw" }]) {
	test(`unavailable model never applies its thinking: ${JSON.stringify(options)}`, async (t) => {
		const h = await harness(t, { ...options, state: saved("max") });
		await h.start();
		assert.equal(h.level, "low");
		assert.equal(h.model.id, "a");
		assert.equal(h.notifications.length, 1);
		assert.equal((await h.state()).thinkingLevel, "max");
	});
}

test("model capabilities clamp the restored effort before persistence", async (t) => {
	const h = await harness(t, { state: saved("max", plainModel) });
	await h.start();
	assert.equal(h.model.id, "plain");
	assert.equal(h.level, "off");
	assert.equal((await h.state()).thinkingLevel, "off");
});

test("shutdown does not overwrite a newer session's saved selection", async (t) => {
	const h = await harness(t, { state: { ...saved("max"), updatedAt: Date.now() + 60_000 } });
	await h.shutdown();
	assert.equal((await h.state()).thinkingLevel, "max");
	assert.equal((await h.state()).modelId, "b");
});

test("disabling model persistence neither restores nor records; re-enabling restores", async (t) => {
	let enabled = false;
	const h = await harness(t, { enabled: () => enabled, state: saved("max") });
	await h.start();
	await h.pi.setModel(modelB);
	await h.shutdown();
	assert.deepEqual(await h.state(), saved("max"));
	enabled = true;
	await h.start("new");
	assert.equal(h.level, "max");
});

test("--no-recent-model neither restores nor records the run's selections", async (t) => {
	const h = await harness(t, { disabled: true, state: saved("max") });
	await h.start();
	await h.pi.setModel(modelB);
	await h.emit("thinking_level_select", { level: "high", previousLevel: "medium" });
	await h.shutdown();
	assert.deepEqual(await h.state(), saved("max"));
});

test("a run without a UI (print/json subagent) does not record its model at shutdown", async (t) => {
	const h = await harness(t, {
		hasUI: false,
		args: ["--mode", "json", "-p", "--model", "test/a"],
		state: saved("max"),
	});
	await h.start();
	await h.shutdown();
	assert.deepEqual(await h.state(), saved("max"));
});

test("an explicit --models thinking level wins over the saved one", async (t) => {
	const h = await harness(t, {
		args: ["--models", "test/b:high"],
		scoped: [{ model: modelB, thinkingLevel: "high" }],
		state: saved("low"),
	});
	await h.start();
	assert.equal(h.model.id, "b");
	assert.equal(h.level, "high");
});

test("an explicit --models scope is not overridden by an out-of-scope recent model", async (t) => {
	const outside = await harness(t, { args: ["--models", "test/a"], scoped: [modelA], state: saved("max") });
	await outside.start();
	assert.deepEqual(outside.calls, []);
	const inside = await harness(t, { args: ["--models=test/a,test/b"], scoped: [modelA, modelB], state: saved("max") });
	await inside.start();
	assert.equal(inside.model.id, "b");
	assert.equal(inside.level, "max");
});
