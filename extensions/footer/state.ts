import type { RateWindow } from "../quota/quotas";
import { providerQuotas, type ProviderQuotaSnapshot } from "../quota/provider-quota";

export interface FooterState {
	currentModelProvider: string | undefined;
	currentModelId: string | undefined;
	currentModelReasoning: boolean;
	/** Account the selected model's quota belongs to (see quotaKey); undefined for a virtual model. */
	currentQuotaKey: string | undefined;
	thinkingLevel: string;
	rateWindows: RateWindow[];
	providerQuotas: Map<string, ProviderQuotaSnapshot>;
	tokenSpeed: number | null; // output tokens / second of the last measurable reply without tool calls
	/** First streamed text or thinking delta. */
	streamFirstDelta: number | null;
	/** First streamed text delta, i.e. after any reasoning. */
	streamFirstAnswerDelta: number | null;
	streamLastModelUpdate: number | null;
	/** Whole-message usage cannot separate tool arguments from reply text. */
	streamHasToolCall: boolean;
	gitAdded: number;
	gitRemoved: number;
	gitDirty: boolean;
	gitRefreshInFlight: boolean;
	/** A git refresh was requested while one was running; run once more after it. */
	gitRefreshQueued: boolean;
	/** Session leaf when git was last read; a new entry (e.g. a `!` command's result) triggers a re-read. */
	gitCheckedLeafId: string | null | undefined;
	/** Account-quota polling per provider: last request time and whether one is pending. */
	quotaPolls: Map<string, { lastFetch: number; inFlight: boolean }>;
	copilotCredits: string | undefined;
}

export function createState(): FooterState {
	return {
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
	};
}
