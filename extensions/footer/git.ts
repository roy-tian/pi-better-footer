import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GIT_TIMEOUT_MS = 4000;

/**
 * Run git without a shell. `code` is undefined when git did not run to completion
 * (timed out, killed, missing, or output too large). pi.exec is not used: it reports
 * a timed-out command as exit code 0, and it cannot set GIT_INDEX_FILE without an
 * `env` executable, which Windows lacks.
 */
function git(
	args: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
): Promise<{ code: number | undefined; stdout: string }> {
	return new Promise((done) => {
		execFile(
			"git",
			args,
			{ cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(error, stdout) => {
				const code = !error ? 0 : !error.killed && typeof error.code === "number" ? error.code : undefined;
				done({ code, stdout: String(stdout) });
			},
		);
	});
}

function parseGitNumstat(output: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of output.split("\n")) {
		const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
		if (!match) continue;
		if (match[1] !== "-") added += Number(match[1]);
		if (match[2] !== "-") removed += Number(match[2]);
	}
	return { added, removed };
}

export async function readGitChanges(cwd: string) {
	let tempDir: string | undefined;
	try {
		const repo = await git(["rev-parse", "--show-toplevel", "--git-path", "index"], cwd);
		if (repo.code !== 0) return undefined;
		const [repoRoot = "", realIndex = ""] = repo.stdout.split("\n").map((line) => line.trim());
		if (!repoRoot) return undefined;

		const head = await git(["rev-parse", "--verify", "HEAD"], repoRoot);
		if (head.code === undefined) return undefined;
		const hasHead = head.code === 0;

		// A throwaway index includes untracked files without touching the real index.
		tempDir = await mkdtemp(join(tmpdir(), "pi-status-footer-"));
		const indexPath = join(tempDir, "index");
		const env = { ...process.env, GIT_INDEX_FILE: indexPath, GIT_OPTIONAL_LOCKS: "0" };
		const indexedGit = (args: string[]) => git(args, repoRoot, env);

		// Seed from a copy of the real index when HEAD exists: its cached stat data
		// lets `git diff` skip unchanged files instead of re-hashing the whole tree.
		let seeded = false;
		if (hasHead && realIndex) {
			seeded = await copyFile(resolve(cwd, realIndex), indexPath).then(
				() => true,
				() => false,
			);
		}
		if (!seeded) {
			const seed = await indexedGit(hasHead ? ["read-tree", "HEAD"] : ["read-tree", "--empty"]);
			if (seed.code !== 0) return undefined;
		}
		const intentToAdd = await indexedGit(["add", "--intent-to-add", "--all", "--", "."]);
		if (intentToAdd.code !== 0) return undefined;
		const diff = await indexedGit([
			"diff",
			"--numstat",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			...(hasHead ? ["HEAD"] : []),
			"--",
		]);
		if (diff.code !== 0) return undefined;
		return { ...parseGitNumstat(diff.stdout), dirty: diff.stdout.trim().length > 0 };
	} catch {
		// Not a Git repo, Git unavailable, or a refresh timed out.
		return undefined;
	} finally {
		if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}
