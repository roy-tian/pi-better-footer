import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

async function load(url, dependencies) {
	const source = stripTypeScriptTypes(await readFile(new URL(url, import.meta.url), "utf8"));
	const context = createContext({ console, process });
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
	return module.namespace;
}

test("one entry registers all features; settings toggle independently and persist", async () => {
	let stored = { keepRecentModel: true, skipExhaustedScopedModels: true };
	const registered = [];
	const commands = new Map();
	const module = await load("../extensions/index.ts", {
		"./footer/index": { default: () => registered.push("footer") },
		"./recent-model": { default: (_pi, options) => registered.push(["recent", options]) },
		"./skip-unavailable": { default: (_pi, options) => registered.push(["skip", options]) },
		"./settings": {
			loadSettings: () => ({ ...stored }),
			saveSettings: async (next) => {
				stored = { ...next };
			},
		},
	});
	module.default({ registerCommand: (name, command) => commands.set(name, command) });
	assert.equal(registered[0], "footer");
	assert.equal(registered[1][0], "recent");
	assert.equal(registered[2][0], "skip");
	assert.equal(commands.size, 1);
	const recent = registered[1][1].enabled;
	const skip = registered[2][1].enabled;
	const choices = ["Keep model and thinking level: on", "Skip exhausted scoped models: on", undefined];
	await commands.get("better-footer").handler("", {
		hasUI: true,
		ui: { select: async () => choices.shift(), notify: () => {} },
	});
	assert.equal(recent(), false);
	assert.equal(skip(), false);
	assert.deepEqual(stored, { keepRecentModel: false, skipExhaustedScopedModels: false });
	// The footer is always registered; neither toggle disables quota display.
	assert.equal(registered[0], "footer");
});

test("the settings menu builds on changes another Pi process saved", async () => {
	let stored = { keepRecentModel: true, skipExhaustedScopedModels: true };
	let recent;
	let command;
	const module = await load("../extensions/index.ts", {
		"./footer/index": { default() {} },
		"./recent-model": {
			default: (_pi, options) => {
				recent = options.enabled;
			},
		},
		"./skip-unavailable": { default() {} },
		"./settings": {
			loadSettings: () => ({ ...stored }),
			saveSettings: async (next) => {
				stored = { ...next };
			},
		},
	});
	module.default({
		registerCommand: (_name, value) => {
			command = value;
		},
	});
	// Another process turned model persistence off after this one started.
	stored = { keepRecentModel: false, skipExhaustedScopedModels: true };
	const menus = [];
	const choices = ["Skip exhausted scoped models: on", undefined];
	await command.handler("", {
		hasUI: true,
		ui: {
			select: async (_title, options) => {
				menus.push(options);
				const choice = choices.shift();
				// ...and turns it back on while this menu is still open.
				if (choice) stored = { ...stored, keepRecentModel: true };
				return choice;
			},
			notify() {},
		},
	});
	assert.equal(menus[0][0], "Keep model and thinking level: off");
	assert.deepEqual(stored, { keepRecentModel: true, skipExhaustedScopedModels: false });
	assert.equal(menus[1][0], "Keep model and thinking level: on");
	assert.equal(recent(), true);
});

test("a failed settings save leaves both toggles unchanged", async () => {
	const calls = [];
	const module = await load("../extensions/index.ts", {
		"./footer/index": { default() {} },
		"./recent-model": { default: (_pi, options) => calls.push(options.enabled) },
		"./skip-unavailable": { default: (_pi, options) => calls.push(options.enabled) },
		"./settings": {
			loadSettings: () => ({ keepRecentModel: true, skipExhaustedScopedModels: true }),
			saveSettings: async () => {
				throw new Error("read-only");
			},
		},
	});
	let command;
	const notices = [];
	module.default({
		registerCommand: (_name, value) => {
			command = value;
		},
	});
	await command.handler("", {
		hasUI: true,
		ui: { select: async () => "Keep model and thinking level: on", notify: (...args) => notices.push(args) },
	});
	assert.equal(calls[0](), true);
	assert.equal(calls[1](), true);
	assert.equal(notices[0][1], "error");
});

test("settings use defaults for missing/invalid fields and save atomically", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "better-footer-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const settings = await load("../extensions/settings.ts", {
		"@earendil-works/pi-coding-agent": { getAgentDir: () => dir },
	});
	assert.deepEqual({ ...settings.loadSettings() }, { keepRecentModel: true, skipExhaustedScopedModels: true });
	await writeFile(settings.settingsPath(), '{"keepRecentModel":false,"skipExhaustedScopedModels":"no"}');
	assert.deepEqual({ ...settings.loadSettings() }, { keepRecentModel: false, skipExhaustedScopedModels: true });
	await settings.saveSettings({ keepRecentModel: true, skipExhaustedScopedModels: false });
	assert.deepEqual(JSON.parse(await readFile(settings.settingsPath(), "utf8")), {
		keepRecentModel: true,
		skipExhaustedScopedModels: false,
	});
});
