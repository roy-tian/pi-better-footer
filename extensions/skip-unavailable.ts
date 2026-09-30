import type { ExtensionAPI, ExtensionContext, ModelSelectEvent } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { isQuotaExhausted, readProviderQuota } from "./quota/provider-quota";
import { quotaKey } from "./quota/quotas";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type ModelRef = { provider: string; id: string } | undefined;

const sameModel = (left: ModelRef, right: ModelRef) => left?.provider === right?.provider && left?.id === right?.id;

/** The per-model or default thinking level Pi applies when switching to `model`, if configured. */
function configuredThinkingLevel(ctx: ExtensionContext, model: ModelSelectEvent["model"]): ThinkingLevel | undefined {
	try {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
		return settings.getModelThinkingLevel(model.provider, model.id) ?? settings.getDefaultThinkingLevel();
	} catch {
		return undefined;
	}
}

/** Matches Pi's own "Switched to …" status wording. */
const describeModel = (model: ModelSelectEvent["model"], thinkingLevel: ThinkingLevel) =>
	`${model.name || model.id}${model.reasoning && thinkingLevel !== "off" ? ` (thinking: ${thinkingLevel})` : ""}`;

export default function (pi: ExtensionAPI, options: { enabled: () => boolean } = { enabled: () => true }) {
	let pendingCycle: { direction: 1 | -1; at: number; thinkingLevel: ThinkingLevel } | undefined;
	let unsubscribe: (() => void) | undefined;
	let session = 0;

	const takeCycleIntent = (
		event: ModelSelectEvent,
		models: readonly ExtensionContext["scopedModels"][number][],
	): { direction: 1 | -1; thinkingLevel?: ThinkingLevel } => {
		const pending = pendingCycle;
		pendingCycle = undefined;
		if (pending && Date.now() - pending.at < 1000) return pending;

		const previousIndex = models.findIndex((item) => sameModel(item.model, event.previousModel));
		const selectedIndex = models.findIndex((item) => sameModel(item.model, event.model));
		if (previousIndex < 0 || selectedIndex < 0 || models.length < 3) return { direction: 1 };
		if ((selectedIndex - previousIndex + models.length) % models.length === 1) return { direction: 1 };
		if ((previousIndex - selectedIndex + models.length) % models.length === 1) return { direction: -1 };
		return { direction: 1 };
	};

	pi.on("session_start", (_event, ctx) => {
		unsubscribe?.();
		unsubscribe = undefined;
		pendingCycle = undefined;
		session++;
		if (ctx.mode !== "tui") return;

		// Observe Pi's configured cycle keys without consuming them. Listeners run
		// before the editor handles the key, so this is the pre-cycle thinking level.
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			const keybindings = getKeybindings();
			if (!options.enabled()) {
				pendingCycle = undefined;
			} else if (keybindings.matches(data, "app.model.cycleForward")) {
				pendingCycle = { direction: 1, at: Date.now(), thinkingLevel: pi.getThinkingLevel() };
			} else if (keybindings.matches(data, "app.model.cycleBackward")) {
				pendingCycle = { direction: -1, at: Date.now(), thinkingLevel: pi.getThinkingLevel() };
			}
			return undefined;
		});
	});

	pi.on("session_shutdown", () => {
		session++;
		unsubscribe?.();
		unsubscribe = undefined;
		pendingCycle = undefined;
	});

	const skipUnusable = async (
		event: ModelSelectEvent,
		ctx: ExtensionContext,
		{ direction, thinkingLevel: previousThinkingLevel }: { direction: 1 | -1; thinkingLevel?: ThinkingLevel },
		currentSession: number,
	) => {
		// Let Pi finish the cycle first, so its "Switched to …" status line is in
		// place before any correction below replaces it.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		// Quota reads are awaited; a later Ctrl+P or /model choice must win over this cycle.
		const superseded = () => !options.enabled() || session !== currentSession || !sameModel(ctx.model, event.model);
		const models = ctx.scopedModels;
		let startIndex = models.findIndex((item) => sameModel(item.model, event.model));
		if (startIndex < 0) startIndex = 0;

		const quotaByKey = new Map<string, Promise<Awaited<ReturnType<typeof readProviderQuota>>>>();
		// Start every scoped account's read at once so their timeouts overlap;
		// stacked sequential reads could delay the correction long past the Ctrl+P
		// that started it. Reads are cached and coalesced per account, so cycling
		// repeatedly does not multiply them. readProviderQuota never rejects; the
		// catch keeps a prefetch abandoned by an early return non-fatal.
		const prefetch = (key: string) => {
			let read = quotaByKey.get(key);
			if (!read) {
				read = readProviderQuota(key, ctx);
				void read.catch(() => undefined);
				quotaByKey.set(key, read);
			}
			return read;
		};
		for (const item of models) {
			const key = quotaKey(item.model, ctx.modelRegistry);
			if (key) void prefetch(key);
		}

		const skipped: string[] = [];
		for (let step = 0; step < models.length; step++) {
			const item = models[(startIndex + step * direction + models.length * 2) % models.length];
			const provider = item.model.provider;
			// The reads above all started together; each await normally settles at once.
			// A virtual model can route elsewhere, so it has no quota to check.
			const key = quotaKey(item.model, ctx.modelRegistry);
			const snapshot = key === undefined ? undefined : await prefetch(key);
			if (superseded()) return;
			if (isQuotaExhausted(snapshot)) {
				skipped.push(`${provider}/${item.model.id} (quota exhausted)`);
				continue;
			}

			if (sameModel(item.model, event.model)) return;
			try {
				if (!(await pi.setModel(item.model))) {
					skipped.push(`${provider}/${item.model.id} (unauthenticated)`);
					continue;
				}
				// setModel awaits auth checks and every model_select handler; a cycle or
				// /model choice made meanwhile wins.
				if (!options.enabled() || session !== currentSession || !sameModel(ctx.model, item.model)) return;
				// Match Pi's own cycle straight to this model: its scoped level, else the
				// configured per-model/default level, else the level from before Ctrl+P.
				// Without this, setModel would carry over the level Pi just applied to the
				// skipped model (or "off" if that model cannot reason).
				const thinkingLevel = item.thinkingLevel ?? configuredThinkingLevel(ctx, item.model) ?? previousThinkingLevel;
				if (thinkingLevel) pi.setThinkingLevel(thinkingLevel);
				// An info notice replaces Pi's status line for the skipped model.
				ctx.ui.notify(
					`Switched to ${describeModel(item.model, pi.getThinkingLevel())}; skipped ${skipped.join(", ")}`,
					"info",
				);
				return;
			} catch {
				skipped.push(`${provider}/${item.model.id} (unavailable)`);
			}
		}

		if (superseded()) return;
		let restored = false;
		if (event.previousModel) {
			try {
				// The cycle already applied the exhausted model's thinking level; put the old one back too.
				restored = await pi.setModel(event.previousModel);
				if (
					restored &&
					previousThinkingLevel &&
					session === currentSession &&
					sameModel(ctx.model, event.previousModel)
				) {
					pi.setThinkingLevel(previousThinkingLevel);
				}
			} catch {
				/* Keep the current model if restoring the previous selection fails. */
			}
		}
		ctx.ui.notify(
			`No scoped model with available quota was found${skipped.length ? ` (${skipped.join(", ")})` : ""}` +
				(restored && event.previousModel
					? `; staying on ${describeModel(event.previousModel, pi.getThinkingLevel())}.`
					: "."),
			"warning",
		);
	};

	pi.on("model_select", (event, ctx) => {
		if (
			!options.enabled() ||
			event.source !== "cycle" ||
			ctx.mode !== "tui" ||
			event.model.api === "pi-virtual" ||
			ctx.scopedModels.length < 2
		) {
			pendingCycle = undefined;
			return;
		}
		const intent = takeCycleIntent(event, ctx.scopedModels);
		// Pi awaits model_select handlers before it finishes the cycle, and quota
		// reads can take seconds, so check in the background instead of holding Ctrl+P.
		void skipUnusable(event, ctx, intent, session).catch(() => undefined);
	});
}
