import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Read only the current project's manifest; no parent or plugin-version fallback. */
export async function readProjectVersion(cwd: string): Promise<string | undefined> {
	try {
		const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
		const version = manifest?.version;
		// Keep manifest-controlled terminal escapes and multiline text out of the footer.
		// The anchored pattern also rejects surrounding whitespace.
		if (typeof version !== "string" || !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
			return undefined;
		}
		return version.startsWith("v") ? version : `v${version}`;
	} catch {
		return undefined;
	}
}
