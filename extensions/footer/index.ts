/**
 * Status Footer Extension
 *
 * Redesigned single-line footer.
 *
 * Above the editor (right-aligned):
 *   cwd  branch · +m -n (when dirty)
 * Footer left:
 *   provider/model effort · quota windows · t/s
 * Footer right:
 *   ↑input/cache ↓output CH% · context/window
 *
 * Cost and subscription markers are intentionally omitted. Cached input tokens
 * are shown after the input total in a faint light gray; the current context
 * usage (accent, with warning thresholds) and the dim context-window total
 * close the line.
 *
 * Rate-limit windows (5h / weekly / total) come from provider-specific sources:
 * - OpenAI Codex subscription: official Codex App Server `account/rateLimits/read`
 * - OpenCode Go subscription: official usage API `GET /zen/go/v1/usage`
 *   (rolling/weekly/monthly), authenticated with OPENCODE_GO_API_KEY, Pi's own
 *   opencode-go key, or the opencode CLI's auth.json; falls back to
 *   the opencode.ai dashboard SSR payload, authenticated with
 *   OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE
 * - ZAI (zai / zai-coding-cn): account quota monitor endpoint — api.z.ai or
 *   the open.bigmodel.cn China mirror, per provider — with 429 error-body
 *   fallback
 * - Other providers: auto-detected response headers (`x-ratelimit-*`, etc.)
 *
 * Token speed covers only the streamed part of each assistant reply: time to
 * first token and tool execution are excluded (see measureTokenSpeed).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGitChanges } from "./git";
import { readProviderQuota, rememberProviderQuota } from "../quota/provider-quota";
import {
	COPILOT_PROVIDER,
	COPILOT_CREDITS_REFRESH_MS,
	compareRateWindows,
	detectRateWindows,
	toRateWindows,
	parseLimitError,
	parseCodexUsageHeaders,
	isZaiProvider,
	isOpenCodeGoProvider,
	type RateWindow,
} from "../quota/quotas";
import { createState, type FooterState } from "./state";
import { renderFooter, renderProjectLine, type FooterTheme } from "./render";

const PROJECT_WIDGET_KEY = "status-footer-project";
// The refresh helpers below own the polling cadence; bypass the shared cache's
// age check (in-flight reads are still coalesced) so it cannot skip every
// other scheduled refresh.
const POLL_MAX_AGE_MS = 0;
/**
 * Account quota only moves while Pi is used, so an idle footer polls less:
 * every 10 minutes after 10 idle minutes, then hourly after an idle hour.
 */
const IDLE_POLL_BACKOFF = [
	{ idleMs: 60 * 60_000, intervalMs: 60 * 60_000 },
	{ idleMs: 10 * 60_000, intervalMs: 10 * 60_000 },
];
/** Built-in tools that never change the working tree, so need no git re-read. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

type StreamUsage = { output?: number; reasoning?: number };

/**
 * Output tokens per second while the reply was streaming. Timing starts at the
 * first delta, not message_start: the gap before it is queueing and prompt
 * processing, and for providers that hide reasoning, the reasoning itself. When
 * the provider reports reasoning tokens, only the visible answer is measured,
 * since those tokens may be generated before or between the streamed deltas
 * (a reasoning summary is far shorter than the reasoning it summarizes).
 */
function measureTokenSpeed(
	timing: Pick<FooterState, "streamFirstDelta" | "streamFirstAnswerDelta" | "streamLastModelUpdate">,
	usage: StreamUsage | undefined,
): number | undefined {
	const reasoning = usage?.reasoning ?? 0;
	const tokens = (usage?.output ?? 0) - reasoning;
	const start = reasoning > 0 ? timing.streamFirstAnswerDelta : timing.streamFirstDelta;
	const end = timing.streamLastModelUpdate;
	if (start == null || end == null || tokens <= 0) return undefined;
	// End at the last model delta, not at a delayed message_end callback.
	const sec = (end - start) / 1000;
	return sec > 0.05 ? tokens / sec : undefined;
}

export default function (pi: ExtensionAPI) {
	// Holder rebuilt on each session_start / rebind.
	const H = {
		state: createState(),
		ctx: undefined as ExtensionContext | undefined,
		tui: undefined as { requestRender(force?: boolean): void } | undefined,
		theme: undefined as FooterTheme | undefined,
		footerData: undefined as
			| {
					getGitBranch(): string | null;
					getExtensionStatuses(): ReadonlyMap<string, string>;
					onBranchChange(cb: () => void): () => void;
			  }
			| undefined,
		timer: undefined as ReturnType<typeof setInterval> | undefined,
		/** Last user or agent activity; quota polling backs off after it. */
		lastActivityAt: Date.now(),
	};

	const markActive = () => {
		H.lastActivityAt = Date.now();
	};

	const requestRender = () => {
		try {
			H.tui?.requestRender();
		} catch {
			/* footer not mounted yet */
		}
	};

	const seedFromCtx = () => {
		const ctx = H.ctx;
		if (!ctx) return;
		H.state.currentModelProvider = ctx.model?.provider;
		H.state.currentModelId = ctx.model?.id;
		H.state.currentModelReasoning = !!ctx.model?.reasoning;
		try {
			H.state.thinkingLevel = pi.getThinkingLevel() ?? "off";
		} catch {
			/* ignore */
		}
	};

	const upsertRateWindow = (window: RateWindow) => {
		const index = H.state.rateWindows.findIndex((item) => item.scope === window.scope);
		if (index >= 0) H.state.rateWindows[index] = window;
		else H.state.rateWindows.push(window);
		H.state.rateWindows.sort(compareRateWindows);
		const provider = H.state.currentModelProvider;
		if (provider) rememberProviderQuota(provider, { windows: [...H.state.rateWindows] });
	};

	const seedRateWindowsFromSession = () => {
		const ctx = H.ctx;
		if (!ctx || !isZaiProvider(H.state.currentModelProvider)) return;
		for (const entry of ctx.sessionManager.getEntries()) {
			const message = (
				entry as {
					type: string;
					message?: { role?: string; provider?: string; errorMessage?: string };
				}
			).message;
			if (message?.role !== "assistant" || !message.errorMessage) continue;
			// Another ZAI provider's limit (a separate account) says nothing about this one.
			if (message.provider !== H.state.currentModelProvider) continue;
			const window = parseLimitError(message.errorMessage);
			if (window) upsertRateWindow(window);
		}
	};

	/**
	 * How often the footer polls the provider's account quota; providers not
	 * listed here only update from response headers.
	 *
	 * Codex polling is necessary, not just nice-to-have: the default Codex
	 * transport is `auto`, which resolves to WebSocket, and the WebSocket path
	 * in pi-ai never invokes onResponse, so after_provider_response never fires
	 * and the x-codex-* header merge is inert. Without polling, the percentage
	 * would freeze for the whole window between RPC rounds. The app-server
	 * startup measures <0.5s, so a 60s cadence is cheap while Pi is in use;
	 * idle sessions back off (IDLE_POLL_BACKOFF).
	 */
	const quotaPollInterval = (provider: string | undefined): number | undefined => {
		let base: number;
		if (provider === COPILOT_PROVIDER) base = COPILOT_CREDITS_REFRESH_MS;
		else if (provider === "openai-codex" || isZaiProvider(provider) || isOpenCodeGoProvider(provider)) base = 60_000;
		else return undefined;
		const idle = Date.now() - H.lastActivityAt;
		const backoff = IDLE_POLL_BACKOFF.find((step) => idle >= step.idleMs);
		return backoff ? Math.max(base, backoff.intervalMs) : base;
	};

	/** Refresh the current provider's quota; force=true skips the poll interval. */
	const refreshQuota = async (force = false) => {
		const ctx = H.ctx;
		const state = H.state;
		const provider = state.currentModelProvider;
		const interval = quotaPollInterval(provider);
		// Poll only while the footer is mounted (TUI, between session_start and
		// session_shutdown): print/json/rpc runs never show the result, and a pending
		// read would keep `pi -p` alive until it settles.
		if (!H.timer || !ctx || !provider || interval === undefined) return;
		let poll = state.quotaPolls.get(provider);
		if (!poll) {
			poll = { lastFetch: 0, inFlight: false };
			state.quotaPolls.set(provider, poll);
		}
		if (poll.inFlight) return;
		const now = Date.now();
		if (!force && now - poll.lastFetch < interval) return;

		poll.inFlight = true;
		poll.lastFetch = now;
		try {
			const snapshot = await readProviderQuota(provider, ctx, force, POLL_MAX_AGE_MS);
			// Drop responses for a replaced session or a provider the user has left.
			if (H.state !== state || state.currentModelProvider !== provider || !snapshot) return;
			if (provider === COPILOT_PROVIDER) {
				if (snapshot.copilotCredits) state.copilotCredits = snapshot.copilotCredits;
			} else if (snapshot.windows.length) {
				state.rateWindows = [...snapshot.windows];
			}
		} finally {
			poll.inFlight = false;
			if (H.state === state) requestRender();
		}
	};

	// --- git working-tree changes -------------------------------------------

	/**
	 * Re-read the working tree's +/- counts. Called only when it may have changed:
	 * session start, a branch switch, a tool that can write, the end of an agent
	 * run, a submitted prompt (covers edits made outside Pi), and a new session
	 * entry such as a `!` command's result (checked on the timer tick).
	 */
	const refreshGit = async () => {
		const ctx = H.ctx;
		const state = H.state;
		if (!H.timer || !ctx) return;
		if (state.gitRefreshInFlight) {
			// The running read may predate the change behind this request.
			state.gitRefreshQueued = true;
			return;
		}
		state.gitRefreshInFlight = true;
		state.gitCheckedLeafId = ctx.sessionManager.getLeafId();
		try {
			const changes = await readGitChanges(ctx.cwd);
			if (H.state === state && changes) {
				state.gitAdded = changes.added;
				state.gitRemoved = changes.removed;
				state.gitDirty = changes.dirty;
			}
		} finally {
			state.gitRefreshInFlight = false;
			if (H.state === state) {
				requestRender();
				if (state.gitRefreshQueued) {
					state.gitRefreshQueued = false;
					void refreshGit();
				}
			}
		}
	};

	const mountFooter = (ctx: ExtensionContext) => {
		// The public widget API owns placement; do not depend on TUI child ordering.
		ctx.ui.setWidget(
			PROJECT_WIDGET_KEY,
			(_tui, theme) => ({
				render: (width: number) => [renderProjectLine(H, width, theme as FooterTheme)],
				invalidate() {},
			}),
			{ placement: "aboveEditor" },
		);

		ctx.ui.setFooter((tui, theme, footerData) => {
			H.tui = tui;
			H.theme = theme;
			H.footerData = footerData;
			const unsub = footerData.onBranchChange(() => {
				void refreshGit();
				requestRender();
			});
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					return renderFooter(H, width);
				},
			};
		});
	};

	const stopPolling = () => {
		if (H.timer) {
			clearInterval(H.timer);
			H.timer = undefined;
		}
	};

	const startPolling = () => {
		stopPolling();
		// Periodic tick: keep countdowns alive, poll quota on its own cadence, and
		// re-read git only after the session gained an entry (a `!` command's
		// result has no event of its own).
		H.timer = setInterval(() => {
			if (H.ctx && H.ctx.sessionManager.getLeafId() !== H.state.gitCheckedLeafId) void refreshGit();
			void refreshQuota();
			requestRender();
		}, 5000);
		void refreshGit();
		void refreshQuota(true);
	};

	// --- event wiring --------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		stopPolling();
		// Reset state for the (possibly new) session.
		Object.assign(H, {
			state: createState(),
			ctx,
			tui: undefined,
			theme: undefined,
			footerData: undefined,
			lastActivityAt: Date.now(),
		});
		seedFromCtx();
		seedRateWindowsFromSession();
		if (ctx.mode !== "tui") return;

		mountFooter(ctx);
		startPolling();
	});

	pi.on("session_shutdown", () => {
		stopPolling();
	});

	pi.on("model_select", async (event, ctx) => {
		markActive();
		const providerChanged = H.state.currentModelProvider !== event.model.provider;
		if (providerChanged) {
			const cached = H.state.providerQuotas.get(event.model.provider);
			H.state.rateWindows = cached?.windows ? [...cached.windows] : [];
			H.state.copilotCredits = cached?.copilotCredits;
		}
		H.state.currentModelProvider = event.model.provider;
		H.state.currentModelId = event.model.id;
		H.state.currentModelReasoning = !!event.model.reasoning;
		H.ctx = ctx;

		// Only a provider change needs an immediate forced read; switching models
		// within one provider shares the same account quota and the normal
		// throttle applies.
		if (ctx.mode === "tui") void refreshQuota(providerChanged);
		requestRender();
	});

	pi.on("thinking_level_select", (event) => {
		markActive();
		H.state.thinkingLevel = event.level ?? "off";
		requestRender();
	});

	// after_provider_response does not say which model answered, and the user can
	// switch models while a request is in flight, so note each request's provider.
	let requestProvider: string | undefined;
	pi.on("before_provider_request", (_event, ctx) => {
		requestProvider = ctx.model?.provider;
	});

	pi.on("after_provider_response", (event) => {
		// Headers from a request sent before a model switch describe the previous
		// provider; never credit them to the newly selected one.
		if (requestProvider !== undefined && requestProvider !== H.state.currentModelProvider) return;
		// Derive rate-limit windows from response headers.
		const raw = detectRateWindows(event.headers);
		const windows = toRateWindows(raw);
		// Codex: opportunistically merge x-codex-* response headers into the cached
		// windows. The ~60s RPC backbone stays authoritative; this only refreshes
		// percentages (and countdowns when reset-at/after is present) and spawns no
		// process. Over the default WebSocket transport this event never fires at
		// all, so the header merge is a no-op there and the RPC poll carries the
		// load; it still helps for the SSE transport / SSE fallback.
		if (H.state.currentModelProvider === "openai-codex") {
			const fromHeaders = parseCodexUsageHeaders(event.headers, event.status, H.state.rateWindows);
			if (fromHeaders.length > 0) {
				for (const w of fromHeaders) upsertRateWindow(w);
			}
		}
		// Codex, OpenCode Go, and ZAI use authoritative account-usage sources; do
		// not replace those windows with ordinary per-request throttling headers.
		if (
			windows.length > 0 &&
			H.state.currentModelProvider !== "openai-codex" &&
			!isOpenCodeGoProvider(H.state.currentModelProvider) &&
			!isZaiProvider(H.state.currentModelProvider)
		) {
			H.state.rateWindows = windows;
			const provider = H.state.currentModelProvider;
			if (provider) rememberProviderQuota(provider, { windows });
		}
		requestRender();
	});

	const resetStreamTiming = () => {
		H.state.streamFirstDelta = null;
		H.state.streamFirstAnswerDelta = null;
		H.state.streamLastModelUpdate = null;
	};

	pi.on("message_start", (event) => {
		if (event.message?.role === "assistant") resetStreamTiming();
	});

	pi.on("message_update", (event) => {
		if (event.message?.role !== "assistant") return;
		const now = performance.now();
		const kind = event.assistantMessageEvent?.type;
		if (kind?.endsWith("_delta")) {
			H.state.streamFirstDelta ??= now;
			if (kind !== "thinking_delta") H.state.streamFirstAnswerDelta ??= now;
		}
		H.state.streamLastModelUpdate = now;
	});

	pi.on("message_end", (event) => {
		markActive();
		const msg = event.message as
			| { role?: string; provider?: string; usage?: StreamUsage; errorMessage?: string }
			| undefined;
		if (msg?.role !== "assistant") {
			requestRender();
			return;
		}

		// Fallback when ZAI's quota-monitor request is unavailable: its 429 body
		// still carries the exhausted window and reset time. Only the provider that
		// produced the error is known to be exhausted.
		if (msg.errorMessage && msg.provider === H.state.currentModelProvider && isZaiProvider(msg.provider)) {
			const window = parseLimitError(msg.errorMessage);
			if (window) upsertRateWindow(window);
		}

		// A completed turn is exactly when account usage moves, so check right
		// away instead of waiting for the next timer tick. Still subject to the
		// poll interval: an agent loop ends many assistant messages per prompt.
		void refreshQuota();

		const speed = measureTokenSpeed(H.state, msg.usage);
		if (speed !== undefined) H.state.tokenSpeed = speed;
		resetStreamTiming();
		requestRender();
	});

	// A submitted prompt ends any idle stretch: re-read quota that may have been
	// polled up to an hour ago, and pick up edits made outside Pi meanwhile.
	pi.on("input", () => {
		markActive();
		void refreshQuota();
		void refreshGit();
	});

	pi.on("agent_start", () => {
		markActive();
	});

	pi.on("tool_execution_end", (event) => {
		markActive();
		if (!READ_ONLY_TOOLS.has(event.toolName)) void refreshGit();
	});

	// One more read once a run ends, which also covers `!` commands run meanwhile.
	pi.on("agent_end", () => {
		markActive();
		void refreshGit();
	});
}
