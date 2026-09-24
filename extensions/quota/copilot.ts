import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { toFiniteNumber } from "./shared";

export const COPILOT_PROVIDER = "github-copilot";
export const COPILOT_CREDITS_REFRESH_MS = 30_000;

/** Mirror pi's Copilot OAuth: an enterprise domain's REST API lives at api.<domain>. */
function copilotApiBaseUrl(enterpriseUrl: string): string {
	if (!enterpriseUrl) return "https://api.github.com";
	try {
		const url = new URL(enterpriseUrl.includes("://") ? enterpriseUrl : `https://${enterpriseUrl}`);
		return `https://api.${url.hostname}`;
	} catch {
		return "https://api.github.com";
	}
}

export async function readGitHubCopilotCredits(): Promise<string | undefined> {
	let credential: { refresh?: unknown; enterpriseUrl?: unknown } | undefined;
	try {
		const auth = JSON.parse(readFileSync(join(getAgentDir(), "auth.json"), "utf8")) as Record<string, unknown>;
		credential = auth[COPILOT_PROVIDER] as typeof credential;
	} catch {
		return undefined;
	}

	if (!credential || typeof credential.refresh !== "string") return undefined;
	const refreshToken = credential.refresh;

	const enterpriseUrl = typeof credential.enterpriseUrl === "string" ? credential.enterpriseUrl.trim() : "";
	const baseUrl = copilotApiBaseUrl(enterpriseUrl);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10_000);
	try {
		const response = await fetch(`${baseUrl}/copilot_internal/user`, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${refreshToken}`,
				"User-Agent": "pi-status-footer",
			},
			signal: controller.signal,
		});
		if (!response.ok) return undefined;

		const payload = (await response.json()) as {
			quota_snapshots?: {
				premium_interactions?: {
					remaining?: unknown;
					quota_remaining?: unknown;
					entitlement?: unknown;
					limit?: unknown;
				};
			};
		};
		const quota = payload.quota_snapshots?.premium_interactions;
		const remaining = toFiniteNumber(quota?.remaining) ?? toFiniteNumber(quota?.quota_remaining);
		const total = toFiniteNumber(quota?.entitlement) ?? toFiniteNumber(quota?.limit);
		if (remaining === undefined || total === undefined || total <= 0) return undefined;
		return `${Math.max(0, Math.floor(remaining))}/${Math.floor(total)}`;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}
