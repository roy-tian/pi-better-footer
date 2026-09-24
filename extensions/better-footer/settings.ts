import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface BetterFooterSettings {
	keepRecentModel: boolean;
	skipExhaustedScopedModels: boolean;
}

export const defaultSettings: BetterFooterSettings = {
	keepRecentModel: true,
	skipExhaustedScopedModels: true,
};

export function settingsPath(): string {
	return join(getAgentDir(), "better-footer.json");
}

export function loadSettings(): BetterFooterSettings {
	try {
		const value: unknown = JSON.parse(readFileSync(settingsPath(), "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...defaultSettings };
		const data = value as Record<string, unknown>;
		return {
			keepRecentModel:
				typeof data.keepRecentModel === "boolean" ? data.keepRecentModel : defaultSettings.keepRecentModel,
			skipExhaustedScopedModels:
				typeof data.skipExhaustedScopedModels === "boolean"
					? data.skipExhaustedScopedModels
					: defaultSettings.skipExhaustedScopedModels,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`Could not read ${settingsPath()}; using better-footer defaults:`, error);
		}
		return { ...defaultSettings };
	}
}

export async function saveSettings(settings: BetterFooterSettings): Promise<void> {
	const path = settingsPath();
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temp, path);
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}
