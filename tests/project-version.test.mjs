import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readProjectVersion } from "../extensions/footer/project.ts";

test("project versions come from the current directory and follow manifest edits", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "footer-version-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const manifest = join(cwd, "package.json");
	assert.equal(await readProjectVersion(cwd), undefined);
	for (const version of ["0.1.2", "1.2.3-beta.1+build.7", "v2.0.0"]) {
		await writeFile(manifest, JSON.stringify({ version }));
		assert.equal(await readProjectVersion(cwd), version.startsWith("v") ? version : `v${version}`);
	}
	assert.equal(await readProjectVersion(join(cwd, "missing-child")), undefined, "never use a parent's version");
	for (const content of [
		"{",
		"null",
		"{}",
		"[]",
		...[12, "", "   ", "1.2.3\n", "1.2.3\u001b[31m", "bad"].map((version) => JSON.stringify({ version })),
	]) {
		await writeFile(manifest, content);
		assert.equal(await readProjectVersion(cwd), undefined, content);
	}
	await rm(manifest);
	assert.equal(await readProjectVersion(cwd), undefined);
});
