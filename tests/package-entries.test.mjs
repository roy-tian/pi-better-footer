import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";

const packageUrl = new URL("../package.json", import.meta.url);

test("one Pi package declares a single better-footer extension entry", async () => {
	const manifest = JSON.parse(await readFile(packageUrl, "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./extensions/better-footer/index.ts"]);
	for (const entry of manifest.pi.extensions) {
		assert.ok((await stat(new URL(`../${entry}`, import.meta.url))).isFile(), entry);
	}
});

test("npm package includes linked English and Chinese READMEs", async () => {
	const manifest = JSON.parse(await readFile(packageUrl, "utf8"));
	for (const name of ["README.md", "README_zh.md"]) {
		assert.ok(manifest.files.includes(name), `${name} must ship in the package`);
		const content = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
		assert.match(content, /\[English\]\(README\.md\).*\[简体中文\]\(README_zh\.md\)/);
	}
});
