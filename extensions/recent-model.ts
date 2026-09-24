/**
 * Restore the most recently active model and thinking effort after /new or restart.
 * State is stored per working directory without changing configured defaults.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

interface ModelRef {
	provider: string;
	modelId: string;
}

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface RecentModelState extends ModelRef {
	version: 1;
	thinkingLevel?: ThinkingLevel;
	updatedAt: number;
}

const STATE_VERSION = 1 as const;
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function statePath(cwd: string): string {
	const key = createHash("sha256").update(resolve(cwd)).digest("hex");
	return join(getAgentDir(), "recent-models", `${key}.json`);
}

function modelRef(ctx: ExtensionContext): ModelRef | undefined {
	const model = ctx.model;
	return model ? { provider: model.provider, modelId: model.id } : undefined;
}

function modelsEqual(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
	return left?.provider === right?.provider && left?.modelId === right?.modelId;
}

async function loadState(cwd: string): Promise<RecentModelState | undefined> {
	try {
		const parsed = JSON.parse(await readFile(statePath(cwd), "utf8")) as Partial<RecentModelState>;
		if (
			parsed.version !== STATE_VERSION ||
			typeof parsed.provider !== "string" ||
			typeof parsed.modelId !== "string" ||
			typeof parsed.updatedAt !== "number" ||
			!Number.isFinite(parsed.updatedAt)
		) {
			return undefined;
		}
		return {
			version: STATE_VERSION,
			provider: parsed.provider,
			modelId: parsed.modelId,
			thinkingLevel: isThinkingLevel(parsed.thinkingLevel) ? parsed.thinkingLevel : undefined,
			updatedAt: parsed.updatedAt,
		};
	} catch {
		return undefined;
	}
}

async function saveState(cwd: string, ref: ModelRef, thinkingLevel: ThinkingLevel, updatedAt: number): Promise<void> {
	const path = statePath(cwd);
	await mkdir(dirname(path), { recursive: true });

	const existing = await loadState(cwd);
	if (existing && existing.updatedAt > updatedAt) return;

	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const state: RecentModelState = {
		version: STATE_VERSION,
		...ref,
		thinkingLevel,
		updatedAt,
	};

	try {
		await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, path);
	} finally {
		await unlink(temporaryPath).catch(() => undefined);
	}
}

function startupOption(name: string): string | undefined {
	const args = process.argv.slice(2);
	let value: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--") break;
		if (arg === name) value = args[++index] ?? "";
		else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
	}
	return value;
}

function hasConversation(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
}

function shouldRestore(event: SessionStartEvent, ctx: ExtensionContext, disabled: boolean): boolean {
	if (disabled) return false;
	if (event.reason === "new") return true;
	if (event.reason !== "startup") return false;
	if (startupOption("--model") !== undefined || startupOption("--provider") !== undefined) return false;
	return !hasConversation(ctx);
}

function notifyUnavailable(ctx: ExtensionContext, ref: ModelRef): void {
	const text = `Could not restore recent model ${ref.provider}/${ref.modelId}; using the configured default instead`;
	if (ctx.hasUI) {
		ctx.ui.notify(text, "warning");
	} else {
		console.warn(text);
	}
}

export default function registerRecentModel(
	pi: ExtensionAPI,
	options: { enabled: () => boolean } = { enabled: () => true },
) {
	let lastKnownAt = Date.now();
	let restoring = false;
	let pendingSave = Promise.resolve();
	// The flag opts this run out entirely: nothing is restored and nothing is recorded.
	const disabled = () => !options.enabled() || pi.getFlag("no-recent-model") === true;

	function remember(cwd: string, ref: ModelRef, thinkingLevel: ThinkingLevel): Promise<void> {
		const updatedAt = lastKnownAt;
		// Thinking notifications are not awaited by pi; serialize snapshots before shutdown.
		pendingSave = pendingSave
			.then(() => saveState(cwd, ref, thinkingLevel, updatedAt))
			.catch((error) => console.error("Failed to save recent model and thinking effort:", error));
		return pendingSave;
	}

	pi.registerFlag("no-recent-model", {
		description: "Neither restore nor record the recent model and thinking level for this run",
		type: "boolean",
	});

	pi.on("model_select", async (event, ctx) => {
		if (restoring || disabled()) return;
		const ref: ModelRef = { provider: event.model.provider, modelId: event.model.id };
		lastKnownAt = Date.now();
		await remember(ctx.cwd, ref, pi.getThinkingLevel());
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (restoring || disabled()) return;
		const current = modelRef(ctx);
		if (!current) return;
		lastKnownAt = Date.now();
		await remember(ctx.cwd, current, event.level);
	});

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		lastKnownAt = Date.now();
		if (!shouldRestore(event, ctx, disabled())) return;

		const state = await loadState(ctx.cwd);
		if (!state) return;

		const recent: ModelRef = { provider: state.provider, modelId: state.modelId };
		// An explicit --models scope for this run limits which model may be restored.
		const explicitScope = event.reason === "startup" && startupOption("--models") !== undefined;
		const scoped = ctx.scopedModels.find(({ model }) =>
			modelsEqual({ provider: model.provider, modelId: model.id }, recent),
		);
		if (explicitScope && !scoped) return;
		const current = modelRef(ctx);
		const override = event.reason === "startup" ? startupOption("--thinking") : undefined;
		// An explicit --thinking, then an explicit `--models provider/model:level`, win over the saved effort.
		const thinkingLevel = isThinkingLevel(override)
			? override
			: ((explicitScope ? scoped?.thinkingLevel : undefined) ?? state.thinkingLevel);

		restoring = true;
		try {
			if (!modelsEqual(current, recent)) {
				const model = ctx.modelRegistry.find(recent.provider, recent.modelId);
				if (!model || !(await pi.setModel(model))) {
					notifyUnavailable(ctx, recent);
					return;
				}
			}
			// Set effort after the model, which can reset or clamp the current level.
			if (thinkingLevel !== undefined) pi.setThinkingLevel(thinkingLevel);
			await remember(ctx.cwd, recent, pi.getThinkingLevel());
		} catch (error) {
			console.error(`Failed to restore recent model ${recent.provider}/${recent.modelId}:`, error);
			notifyUnavailable(ctx, recent);
		} finally {
			restoring = false;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Runs without a UI (`pi -p`, `--mode json` subagents) never chose a model interactively;
		// recording theirs would make a scripted one-off model the next interactive restore.
		if (disabled() || !ctx.hasUI) return;
		const current = modelRef(ctx);
		if (!current) return;

		await remember(ctx.cwd, current, pi.getThinkingLevel());
	});
}
