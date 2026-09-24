import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	detectRateWindows,
	toRateWindows,
	parseLimitError,
	parseCodexUsageHeaders,
	readZaiRateLimits,
	readOpenCodeGoRateLimits,
} from "../extensions/better-footer/quota/quotas.ts";
import { summarizeSessionUsage } from "../extensions/better-footer/footer/session-stats.ts";
import { readGitChanges } from "../extensions/better-footer/footer/git.ts";

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
	assert.deepEqual(firstStats.totals, { input: 5, output: 2, cacheRead: 5, cacheWrite: 0 });
	summarizeSessionUsage(manager);
	assert.equal(reads, 1);
	entries.push({ type: "message", message: { role: "toolResult", usage: { output: 3 } } });
	assert.equal(summarizeSessionUsage(manager).totals.output, 5);
	entries.push({ type: "usage", usage: { input: 7, output: 1 } });
	assert.equal(summarizeSessionUsage(manager).totals.input, 12);
	assert.equal(reads, 1);
	entries.splice(0, entries.length, { type: "message", message: { role: "assistant", usage: { input: 10 } } });
	assert.equal(summarizeSessionUsage(manager).totals.input, 10);
	assert.equal(summarizeSessionUsage(manager).latestHit, 0);
});
