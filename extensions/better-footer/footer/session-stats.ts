import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type SessionManager = ExtensionContext["sessionManager"];
type SessionEntry = ReturnType<SessionManager["getEntries"]>[number];

type Usage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
export interface SessionStats {
	totals: { input: number; output: number; cacheRead: number; cacheWrite: number };
	latestHit?: number;
}

interface CachedStats extends SessionStats {
	count: number;
	lastEntry?: SessionEntry;
}

const cache = new WeakMap<SessionManager, CachedStats>();

/** Session file entries are append-only until the active session is replaced. */
export function summarizeSessionUsage(manager: SessionManager | undefined): SessionStats {
	if (!manager) return { totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const entries = manager.getEntries();
	const previous = cache.get(manager);
	const resume =
		previous !== undefined &&
		entries.length >= previous.count &&
		(previous.count === 0 || entries[previous.count - 1] === previous.lastEntry);
	const totals = resume ? { ...previous.totals } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let latestHit = resume ? previous.latestHit : undefined;

	for (let index = resume ? previous.count : 0; index < entries.length; index++) {
		const entry = entries[index] as {
			type: string;
			message?: { role?: string; usage?: Usage };
			usage?: Usage;
		};
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message?.role === "assistant") {
			usage = entry.message.usage;
			if (usage) {
				const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
				if (prompt > 0) latestHit = ((usage.cacheRead ?? 0) / prompt) * 100;
			}
		} else if (entry.type === "message" && entry.message?.role === "toolResult") {
			usage = entry.message.usage;
		} else if (entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction") {
			// "usage" entries record side LLM calls (extensions, tools); pi's own footer counts them too.
			usage = entry.usage;
		}
		if (!usage) continue;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
	}

	cache.set(manager, { totals, latestHit, count: entries.length, lastEntry: entries.at(-1) });
	return { totals, latestHit };
}
