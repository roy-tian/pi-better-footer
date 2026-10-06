import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CHATGPT_QUOTA_KEY,
	detectRateWindows,
	toRateWindows,
	parseLimitError,
	parseCodexUsageHeaders,
	readZaiRateLimits,
	readOpenCodeGoRateLimits,
} from "../extensions/quota/quotas.ts";
import { summarizeSessionUsage } from "../extensions/footer/session-stats.ts";
import { readGitChanges } from "../extensions/footer/git.ts";
import { createState } from "../extensions/footer/state.ts";
import { renderFooter } from "../extensions/footer/render.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

const at = Date.now();

test("generic response headers prefer token windows and sort by reset", () => {
	const windows = toRateWindows(
		detectRateWindows({
			"x-ratelimit-limit-requests": "500",
			"x-ratelimit-remaining-requests": "250",
			"x-ratelimit-limit-tokens": "100",
			"x-ratelimit-remaining-tokens": "20",
			"x-ratelimit-reset-tokens": "1h30m",
		}),
	);
	assert.equal(windows.length, 1);
	assert.equal(windows[0].percent, 20);
	assert.equal(windows[0].resetSec, 5400);
});

test("absolute epoch reset headers become a countdown", () => {
	for (const reset of [String(Math.floor(Date.now() / 1000) + 600), String(Date.now() + 600_000)]) {
		const [window] = toRateWindows(
			detectRateWindows({
				"x-ratelimit-limit-tokens": "100",
				"x-ratelimit-remaining-tokens": "0",
				"x-ratelimit-reset-tokens": reset,
			}),
		);
		assert.ok(window.resetSec > 590 && window.resetSec <= 600, reset);
	}
});

/** A zone-less Beijing (UTC+8) wall-clock stamp, as the ZAI gateways print it. */
const beijingStamp = (at: Date) => {
	const shifted = new Date(at.getTime() + 8 * 3600_000);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
};

test("ZAI 429 fallback reads the Beijing-time reset and marks the window exhausted", () => {
	const stamp = beijingStamp(new Date(Date.now() + 3600_000));
	for (const message of [
		`429: {"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at ${stamp}"}`,
		`429 已达到 5 小时的使用上限。您的限额将在 ${stamp} 重置。`,
	]) {
		const window = parseLimitError(message);
		assert.equal(window?.scope, "zai:3", message);
		assert.equal(window?.percent, 0);
		assert.ok(window && window.resetSec > 3598 && window.resetSec <= 3600, `${message}: ${window?.resetSec}`);
	}
	const weekly = parseLimitError(
		`429 已达到每周的使用上限。您的限额将在 ${beijingStamp(new Date(Date.now() + 86400_000))} 重置。`,
	);
	assert.equal(weekly?.scope, "zai:6");
});

test("Codex headers keep an earlier reset when the response omits one", () => {
	const previous = [
		{ scope: "codex:primary", percent: 50, hasReset: true, resetSec: 600, capturedAt: at, windowDurationMins: 300 },
	];
	const windows = parseCodexUsageHeaders({ "x-codex-primary-used-percent": "70" }, 200, previous);
	assert.deepEqual(windows, [{ ...previous[0], percent: 30 }]);
	assert.deepEqual(parseCodexUsageHeaders({}, 200, previous), []);
});

test("ZAI quota uses CREDIT_LIMIT used percent, and monthly absolute counts", async () => {
	const oldFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				success: true,
				data: {
					limits: [
						{ type: "CREDIT_LIMIT", unit: 3, percentage: 25, remaining: 750, nextResetTime: Date.now() + 3600_000 },
						{
							type: "CREDIT_LIMIT",
							unit: 6,
							percentage: 40,
							remaining: 600,
							nextResetTime: Date.now() + 7 * 86400_000,
						},
						{ type: "TIME_LIMIT", unit: 5, usage: 1000, currentValue: 25, remaining: 975 },
					],
				},
			}),
		);
	try {
		const registry = {
			getApiKeyForProvider: async () => "test-key",
			getAll: () => [{ provider: "zai", baseUrl: "https://api.z.ai/api/coding/paas/v4" }],
		};
		const windows = await readZaiRateLimits(registry as never, "zai");
		assert.deepEqual(
			windows.map((w) => w.percent),
			[75, 60, 97.5],
		);
		assert.deepEqual(
			windows.map((w) => w.scope),
			["zai:3", "zai:6", "zai:monthly"],
		);
		assert.deepEqual(
			windows.map((w) => w.advisory ?? false),
			[false, false, true],
		);
	} finally {
		globalThis.fetch = oldFetch;
	}
});

test("a zai-named provider hosted elsewhere never sends its key to Z.AI", async () => {
	const oldFetch = globalThis.fetch;
	let fetched = 0;
	globalThis.fetch = async () => {
		fetched++;
		return new Response("{}");
	};
	try {
		const registry = {
			getApiKeyForProvider: async () => "openrouter-key",
			getAll: () => [{ provider: "zai-openrouter", baseUrl: "https://openrouter.ai/api/v1" }],
		};
		assert.deepEqual(await readZaiRateLimits(registry as never, "zai-openrouter"), []);
		assert.equal(fetched, 0);
	} finally {
		globalThis.fetch = oldFetch;
	}
});

test("a reset of 0s is an expired window, not an untimed exhausted one", () => {
	const [window] = toRateWindows(
		detectRateWindows({
			"x-ratelimit-limit-tokens": "1000",
			"x-ratelimit-remaining-tokens": "0",
			"x-ratelimit-reset-tokens": "0s",
		}),
	);
	assert.equal(window.hasReset, true);
	assert.equal(window.resetSec, 0);
});

test("Codex header merges keep a window's credit-backed advisory flag", () => {
	const previous = [
		{ scope: "codex:primary", percent: 0, hasReset: true, resetSec: 600, capturedAt: at, advisory: true },
	];
	const [window] = parseCodexUsageHeaders({ "x-codex-primary-used-percent": "100" }, 200, previous);
	assert.equal(window.advisory, true);
});

test("git changes count modified and untracked lines without touching the real index", async () => {
	const dir = mkdtempSync(join(tmpdir(), "git-changes-test-"));
	try {
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
		git("init", "-q");
		writeFileSync(join(dir, "tracked.txt"), "a\nb\nc\n");
		git("add", "tracked.txt");
		git(
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-qm",
			"init",
		);
		writeFileSync(join(dir, "tracked.txt"), "a\nB\nc\nd\n");
		writeFileSync(join(dir, "untracked.txt"), "1\n2\n");
		assert.deepEqual(await readGitChanges(dir), { added: 4, removed: 1, dirty: true });
		assert.equal(git("status", "--porcelain"), " M tracked.txt\n?? untracked.txt\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("OpenCode Go official usage API maps used to remaining", async () => {
	const oldFetch = globalThis.fetch;
	const oldKey = process.env.OPENCODE_GO_API_KEY;
	process.env.OPENCODE_GO_API_KEY = "test-key";
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				usage: {
					rolling: { percent: 25, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
					weekly: { percent: 40, resetsAt: new Date(Date.now() + 86400_000).toISOString() },
					monthly: { percent: 60, resetsAt: new Date(Date.now() + 15 * 86400_000).toISOString() },
				},
			}),
		);
	try {
		assert.deepEqual(
			(await readOpenCodeGoRateLimits()).map((w) => w.percent),
			[75, 60, 40],
		);
	} finally {
		globalThis.fetch = oldFetch;
		if (oldKey === undefined) delete process.env.OPENCODE_GO_API_KEY;
		else process.env.OPENCODE_GO_API_KEY = oldKey;
	}
});

test("OpenCode Go falls back to the key Pi uses, but only while its models use opencode.ai", async () => {
	const oldFetch = globalThis.fetch;
	const oldKey = process.env.OPENCODE_GO_API_KEY;
	delete process.env.OPENCODE_GO_API_KEY;
	const sent: (string | null)[] = [];
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		sent.push(new Headers(init?.headers).get("authorization"));
		return new Response(JSON.stringify({ usage: { rolling: { percent: 10 } } }));
	}) as typeof fetch;
	const registry = (baseUrl: string) =>
		({
			getAll: () => [{ provider: "opencode-go", baseUrl }],
			getApiKeyForProvider: async () => "pi-key",
		}) as never;
	try {
		assert.deepEqual(
			(await readOpenCodeGoRateLimits(registry("https://opencode.ai/zen/go/v1"))).map((w) => w.percent),
			[90],
		);
		assert.equal(sent[0], "Bearer pi-key");
		sent.length = 0;
		// A models.json override pointing elsewhere keeps its key away from opencode.ai.
		await readOpenCodeGoRateLimits(registry("https://proxy.example.com/v1"));
		assert.ok(!sent.includes("Bearer pi-key"));
	} finally {
		globalThis.fetch = oldFetch;
		if (oldKey !== undefined) process.env.OPENCODE_GO_API_KEY = oldKey;
	}
});

test("session stats reuse append-only history, but reset after replacement", () => {
	let reads = 0;
	const first = {
		type: "message",
		message: {
			role: "assistant",
			get usage() {
				reads++;
				return { input: 5, output: 2, cacheRead: 5 };
			},
		},
	};
	const entries: object[] = [first];
	const manager = { getEntries: () => entries } as never;
	const firstStats = summarizeSessionUsage(manager);
	assert.equal(firstStats.latestHit, 50);
	assert.deepEqual(firstStats.totals, { input: 5, output: 2, cacheRead: 5, cacheWrite: 0, cost: 0 });
	summarizeSessionUsage(manager);
	assert.equal(reads, 1);
	entries.push({ type: "message", message: { role: "toolResult", usage: { output: 3 } } });
	assert.equal(summarizeSessionUsage(manager).totals.output, 5);
	entries.push({ type: "usage", usage: { input: 7, output: 1, cost: { total: 0.25 } } });
	assert.equal(summarizeSessionUsage(manager).totals.input, 12);
	assert.equal(summarizeSessionUsage(manager).totals.cost, 0.25);
	assert.equal(reads, 1);
	entries.splice(0, entries.length, { type: "message", message: { role: "assistant", usage: { input: 10 } } });
	assert.equal(summarizeSessionUsage(manager).totals.input, 10);
	assert.equal(summarizeSessionUsage(manager).latestHit, 0);
});

test("ChatGPT usage hyperlinks fit real terminal widths and close before other footer segments", () => {
	const state = createState();
	state.currentModelProvider = "openai";
	state.currentModelId = "test-model";
	state.currentQuotaKey = CHATGPT_QUOTA_KEY;
	state.providerQuotas = new Map();
	const holder = { state, ctx: undefined };
	for (const width of [0, 1, 8, 18, 32, 80]) {
		const lines = renderFooter(holder, width);
		assert.equal(lines.length, 2);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
		assert.equal(lines[0], "", "no project context leaves the first row blank");
	}
	const [, line] = renderFooter(holder, 80);
	assert.ok(line.includes("\x1b]8;;https://chatgpt.com/settings/usage\x1b\\ChatGPT\x1b]8;;\x1b\\"));
});

test("session segments match the requested order without dangling separators", () => {
	const state = createState();
	Object.assign(state, { currentModelProvider: "test", currentModelId: "model", tokenSpeed: 100 });
	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 18000,
					output: 1500,
					cacheRead: 100000,
					cacheWrite: 10000,
					cost: { total: 0.06 },
				},
			},
		},
	];
	const holder = {
		state,
		ctx: {
			sessionManager: { getCwd: () => "/test", getEntries: () => entries },
			getContextUsage: () => ({ tokens: 20000, percent: 2, contextWindow: 1000000 }),
		} as unknown as ExtensionContext,
	};
	assert.match(
		renderFooter(holder, 120)[1],
		/^↑18k ↓1\.5k R100k W10k CH78\.1% · \$0\.060 · 20k\/1\.0M · 100t\/s {2,}test\/model$/,
	);
	entries[0].message.usage.cost.total = 0;
	// A replaced session entry invalidates the append-only statistics cache.
	entries[0] = { ...entries[0] };
	assert.match(renderFooter(holder, 120)[1], /CH78\.1% · 20k\/1\.0M · 100t\/s/);
	state.tokenSpeed = null;
	assert.match(renderFooter(holder, 120)[1], /CH78\.1% · 20k\/1\.0M/);
	holder.ctx.sessionManager.getEntries = () => [];
	holder.ctx.getContextUsage = () => undefined;
	assert.match(renderFooter(holder, 120)[1], /^\?\/\? {2,}test\/model$/);
});

test("cache counters use accent labels and muted values while context capacity stays dim", () => {
	const state = createState();
	state.tokenSpeed = 34;
	const ctx = {
		sessionManager: {
			getCwd: () => "/test",
			getEntries: () => [
				{
					type: "message",
					message: { role: "assistant", usage: { input: 26000, cacheRead: 53000, cacheWrite: 2000 } },
				},
			],
		},
		getContextUsage: () => ({ tokens: 26000, percent: 2.4, contextWindow: 1100000 }),
	} as unknown as ExtensionContext;
	for (const name of ["dark", "light", "custom-palette"]) {
		const theme = { name, fg: (color: string, text: string) => `<${color}:${text}>`, bold: (text: string) => text };
		const line = renderFooter({ state, ctx, theme }, 1000)[1];
		assert.ok(line.includes("<accent:↑><muted:26k>"));
		assert.ok(line.includes("<accent:R><muted:53k> <accent:W><muted:2.0k>"));
		assert.ok(line.includes("<muted:26k>/<dim:1.1M>"));
		assert.ok(line.includes("<muted:34><dim:t/s>"));
	}
});

test("native cache counters render independently and hide zero token counts", () => {
	for (const [cacheRead, cacheWrite, expected] of [
		[0, 0, ""],
		[500, 0, "R500 CH100.0% · "],
		[0, 200, "W200 · "],
		[500, 200, "R500 W200 CH71.4% · "],
	] as const) {
		const ctx = {
			sessionManager: {
				getCwd: () => "/test",
				getEntries: () => [
					{ type: "message", message: { role: "assistant", usage: { input: 0, output: 0, cacheRead, cacheWrite } } },
				],
			},
			getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 100000 }),
		} as unknown as ExtensionContext;
		const holder = { state: createState(), ctx };
		assert.equal(renderFooter(holder, 120)[1].trimEnd().split(/ {2,}/)[0], `${expected}0/100k`);
		for (const width of [0, 1, 8, 18, 32, 80, 120]) {
			for (const line of renderFooter(holder, width)) assert.ok(visibleWidth(line) <= width);
		}
	}
});

test("live token speed is marked as estimated with or without a theme", () => {
	const state = createState();
	Object.assign(state, { tokenSpeed: 42, tokenSpeedEstimated: true });
	const holder = { state, ctx: undefined };
	assert.ok(renderFooter(holder, 100)[1].includes("~42t/s"));
	const theme = { fg: (color: string, text: string) => `<${color}:${text}>`, bold: (text: string) => text };
	assert.ok(renderFooter({ ...holder, theme }, 500)[1].includes("<muted:~42><dim:t/s>"));
	state.tokenSpeedEstimated = false;
	assert.ok(renderFooter(holder, 100)[1].includes("42t/s"));
	assert.ok(!renderFooter(holder, 100)[1].includes("~42"));
});

test("token speed uses three theme color bands while the unit stays dim", () => {
	const state = createState();
	const bands = [
		{ values: [1, 34, 35, 49, 49.4], color: "muted" },
		{ values: [49.5, 50, 100, 149, 149.4], color: "warning" },
		{ values: [149.5, 150, 200, 1000], color: "error" },
	];
	for (const name of ["dark", "light"]) {
		const theme = {
			name,
			fg: (color: string, text: string) => `<${color}:${text}>`,
			bold: (text: string) => text,
		};
		for (const { values, color } of bands) {
			const expected = color === "warning" && name === "light" ? "syntaxFunction" : color;
			for (const value of values) {
				for (const estimated of [false, true]) {
					Object.assign(state, { tokenSpeed: value, tokenSpeedEstimated: estimated });
					const line = renderFooter({ state, ctx: undefined, theme }, 500)[1];
					assert.ok(line.includes(`<${expected}:${estimated ? "~" : ""}${Math.round(value)}><dim:t/s>`));
				}
			}
		}
	}
});

test("context usage is muted through 70 percent, then warning (darker on light themes) and error", () => {
	const state = createState();
	const theme = {
		name: "dark",
		fg: (color: string, text: string) => `<${color}:${text}>`,
		bold: (text: string) => text,
	};
	for (const [percent, color] of [
		[0, "muted"],
		[1.3, "muted"],
		[70, "muted"],
		[70.1, "warning"],
		[90, "warning"],
		[90.1, "error"],
		[100, "error"],
	] as const) {
		const ctx = {
			sessionManager: { getCwd: () => "/test", getEntries: () => [] },
			getContextUsage: () => ({ tokens: 14000, percent, contextWindow: 1100000 }),
		} as unknown as ExtensionContext;
		for (const name of ["dark", "light", "custom-palette"]) {
			const line = renderFooter({ state, ctx, theme: { ...theme, name } }, 500)[1];
			const expected = color === "warning" && name === "light" ? "syntaxFunction" : color;
			assert.ok(line.includes(`<${expected}:14k>/<dim:1.1M>`));
			assert.ok(!line.includes("\x1b["), "no hard-coded foreground colors");
		}
	}
});

test("Copilot credits share quota warning thresholds across themes", () => {
	const state = createState();
	state.currentModelProvider = "github-copilot";
	for (const name of ["dark", "light", "custom-palette"]) {
		const theme = {
			name,
			fg: (color: string, text: string) => `<${color}:${text}>`,
			bold: (text: string) => text,
		};
		for (const [remaining, color] of [
			[0, "error"],
			[30, "error"],
			[31, "warning"],
			[90, "warning"],
			[91, "muted"],
			[300, "muted"],
			[400, "muted"],
		] as const) {
			state.copilotCredits = `${remaining}/300`;
			state.rateWindows = [
				{ scope: "tokens", percent: (remaining / 300) * 100, hasReset: false, resetSec: 0, capturedAt: Date.now() },
			];
			const line = renderFooter({ state, ctx: undefined, theme }, 500)[1];
			const expected = color === "warning" && name === "light" ? "syntaxFunction" : color;
			assert.ok(line.includes(`<${expected}:${remaining}>/<dim:300>`));
			assert.ok(line.includes(`<${expected}:${Math.round((remaining / 300) * 100)}%>`));
			assert.ok(!line.includes("\x1b["));
			assert.ok(renderFooter({ state, ctx: undefined }, 500)[1].includes(`${remaining}/300`));
		}
	}
});

test("token speed is dropped before quota windows when the line runs short", () => {
	const state = createState();
	const now = Date.now();
	Object.assign(state, {
		currentModelProvider: "openai-codex",
		currentModelId: "gpt",
		tokenSpeed: 42,
		rateWindows: [
			// Keep countdowns away from rounding boundaries while testing layout.
			{ scope: "5h", percent: 80, hasReset: true, resetSec: 4 * 3600 + 1800, capturedAt: now },
			{ scope: "7d", percent: 60, hasReset: true, resetSec: 4 * 86400 + 1800, capturedAt: now },
		],
	});
	const entries = [
		{ type: "message", message: { role: "assistant", usage: { input: 1200, output: 200, cacheRead: 500 } } },
	];
	const holder = {
		state,
		ctx: {
			sessionManager: { getCwd: () => "/test", getEntries: () => entries },
			getContextUsage: () => ({ tokens: 50000, percent: 50, contextWindow: 100000 }),
		} as unknown as ExtensionContext,
	};
	const full = renderFooter(holder, 200)[1].replace(/ {2,}/, "  ");
	assert.ok(full.includes("42t/s") && full.includes("4d 60%"), full);
	// One column short of the full line: the speed goes, both quota windows stay.
	const short = renderFooter(holder, visibleWidth(full) - 1)[1];
	assert.ok(!short.includes("t/s"), short);
	assert.ok(short.includes("4h 80%") && short.endsWith("4d 60%"), short);
	assert.ok(short.includes("CH"), "session detail outlasts the speed too");
});

test("invalid Copilot credits never acquire an exhaustion color", () => {
	const state = createState();
	state.currentModelProvider = "github-copilot";
	const theme = { fg: (color: string, text: string) => `<${color}:${text}>`, bold: (text: string) => text };
	for (const credits of ["0/0", "1/0", "unknown", "?/300", "1/?", `${"9".repeat(310)}/300`, `0/${"9".repeat(310)}`]) {
		state.copilotCredits = credits;
		const line = renderFooter({ state, ctx: undefined, theme }, 1500)[1];
		assert.ok(!line.includes("<error:"));
		assert.ok(!line.includes("<warning:"));
	}
});

test("context capacity stays visible with zero or unknown usage and follows model changes", () => {
	const state = createState();
	Object.assign(state, { currentModelProvider: "test", currentModelId: "model" });
	const holder = {
		state,
		ctx: {
			model: { contextWindow: 1000000 },
			sessionManager: { getCwd: () => "/test", getEntries: () => [] },
			getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 1000000 }),
		} as unknown as ExtensionContext,
	};
	assert.match(renderFooter(holder, 80)[1], /^0\/1\.0M {2,}test\/model$/);
	// Compaction makes usage unknown, not zero; capacity still belongs on screen.
	holder.ctx.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 1000000 });
	assert.match(renderFooter(holder, 80)[1], /^\?\/1\.0M {2,}test\/model$/);
	holder.ctx.getContextUsage = () => undefined;
	assert.match(renderFooter(holder, 80)[1], /^\?\/1\.0M {2,}test\/model$/);
	if (holder.ctx.model) holder.ctx.model.contextWindow = 200000;
	assert.match(renderFooter(holder, 80)[1], /^\?\/200k {2,}test\/model$/);
	// The reported window takes precedence over the model fallback.
	holder.ctx.getContextUsage = () => ({ tokens: 0, percent: 0, contextWindow: 128000 });
	assert.match(renderFooter(holder, 80)[1], /^0\/128k {2,}test\/model$/);
	for (const width of [0, 1, 8, 18, 32]) {
		const line = renderFooter(holder, width)[1];
		assert.ok(visibleWidth(line) <= width);
		if (width >= 18) assert.ok(line.startsWith("0/128k"));
	}
});

test("two footer rows keep Git above left-aligned usage and right-aligned quotas", () => {
	const state = createState();
	Object.assign(state, {
		currentModelProvider: "zai",
		currentModelId: "glm",
		tokenSpeed: 20,
		gitDirty: true,
		projectVersion: "v0.1.2",
		gitAdded: 12,
		gitRemoved: 3,
		rateWindows: [{ scope: "tokens", percent: 80, hasReset: false, resetSec: 0, capturedAt: Date.now() }],
	});
	const entries = [{ type: "message", message: { role: "assistant", usage: { input: 1200, output: 200 } } }];
	let cwd = "/project";
	let branch = "main";
	const holder = {
		state,
		ctx: {
			sessionManager: { getCwd: () => cwd, getEntries: () => entries },
			getContextUsage: () => ({ tokens: 50000, percent: 50, contextWindow: 100000 }),
		} as unknown as ExtensionContext,
		footerData: { getGitBranch: () => branch, getExtensionStatuses: () => new Map([["test", "ready"]]) },
	};
	const [project, usage] = renderFooter(holder, 100);
	assert.ok(project.startsWith("/project  main · v0.1.2 · +12 -3"));
	assert.ok(project.endsWith("ready"));
	const versionTheme = {
		fg: (color: string, text: string) => `<${color}:${text}>`,
		bold: (text: string) => text,
	};
	assert.ok(renderFooter({ ...holder, theme: versionTheme }, 500)[0].includes("<dim:v><muted:0.1.2>"));
	assert.equal(visibleWidth(usage), 100, "model and quota are right-aligned");
	assert.ok(usage.startsWith("↑1.2k ↓200 · 50k/100k · 20t/s"));
	assert.ok(usage.endsWith("zai/glm · 80%"));
	assert.ok(!project.includes("↑"));
	assert.ok(!usage.includes("/project"));
	state.gitDirty = false;
	branch = "next";
	assert.ok(renderFooter(holder, 100)[0].startsWith("/project  next · v0.1.2"));
	state.projectVersion = undefined;
	assert.ok(!renderFooter(holder, 100)[0].includes("v0.1.2"));

	cwd = "/项目/一个很长的工作目录";
	branch = "功能/新布局";
	const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => text };
	for (const width of [0, 1, 2, 8, 18, 32, 80, 120]) {
		const lines = renderFooter({ ...holder, theme }, width);
		assert.equal(lines.length, 2);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
			assert.ok(!line.includes("\n"));
		}
		if (width > 0) assert.ok(lines[0].includes("/"), "keep the project path left-aligned even at one column");
	}
});
