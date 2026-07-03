#!/usr/bin/env bun
/**
 * Typechecks this plugin against the current omp host source (HEAD of the
 * upstream repo), to catch host API drift before it ships in a release.
 *
 * Algorithm:
 *  1. Shallow-clone `OMP_REPO`@`OMP_REF` (defaults: `can1357/oh-my-pi`@`main`)
 *     into a temp dir.
 *  2. `bun install` the clone (frozen lockfile first, falling back to a plain
 *     install on lockfile drift).
 *  3. Compare the local `src/shims/model-roles.{ts,d.ts}` surface against the
 *     cloned upstream `packages/coding-agent/src/config/model-roles.ts`:
 *     built-in role IDs must match, and `RoleInfo.hidden?: boolean` must stay
 *     in sync. This catches local shim/value drift even when the plugin still
 *     typechecks against the real host exports.
 *  4. Emit `.d.ts` declarations for every host package that ships a
 *     `tsconfig.publish.json` (`emitDeclarationOnly`, `noCheck: true` — fast,
 *     never fails on internal type errors).
 *  5. Rewrite each built package's `package.json` so its `types` /
 *     `exports[*].types` entries point at the emitted `dist/types/**` instead
 *     of `src/**.tsx?`, matching what `bun publish` would ship.
 *  6. Swap the two packages this plugin imports directly
 *     (`@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-ai`) in this repo's
 *     `node_modules` for symlinks into the rewritten clone packages.
 *  7. Typecheck against a temp tsconfig that clears `paths` (so the
 *     `config/model-roles` subpath resolves through the swapped package's
 *     real export, not the local shim).
 *  8. Restore the original `node_modules` entries and delete all temp files,
 *     in a `finally` so a typecheck failure still leaves the tree pristine.
 *
 * Override the clone source for an offline run or to pin a known-good ref:
 *   OMP_REPO=https://github.com/you/oh-my-pi.git OMP_REF=v16.3.0 bun run check:omp-head
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const repo = process.env.OMP_REPO ?? "https://github.com/can1357/oh-my-pi.git";
const ref = process.env.OMP_REF ?? "main";

/** Packages with a publishable subset; built + repointed only if present in the clone. */
const HOST_PACKAGES = [
	"utils",
	"ai",
	"catalog",
	"tui",
	"agent",
	"hashline",
	"mnemopi",
	"natives",
	"wire",
	"snapcompact",
	"stats",
	"coding-agent",
];

/** The only packages this plugin imports directly — the sole swap targets. */
const SWAP_TARGETS: ReadonlyArray<{ scope: string; dir: string }> = [
	{ scope: "@oh-my-pi/pi-coding-agent", dir: "coding-agent" },
	{ scope: "@oh-my-pi/pi-ai", dir: "ai" },
];

const repoRoot = path.resolve(import.meta.dir, "..");
const tmpTsconfig = path.join(repoRoot, "tsconfig.omp-head.json");

type Exports = string | { [condition: string]: Exports } | Exports[];

/** Rewrite a `./src/foo.ts(x)` types path to its emitted `./dist/types/foo.d.ts`. */
function rewriteTypesPath(value: string): string {
	return value.replace(/^\.\/src\/(.+)\.tsx?$/, "./dist/types/$1.d.ts");
}

/** Recursively rewrite every `types` condition found in a package `exports` map. */
function rewriteExports(node: Exports): Exports {
	if (typeof node === "string") return node;
	if (Array.isArray(node)) return node.map(rewriteExports);
	const out: { [condition: string]: Exports } = {};
	for (const [key, value] of Object.entries(node)) {
		out[key] = key === "types" && typeof value === "string" ? rewriteTypesPath(value) : rewriteExports(value);
	}
	return out;
}

/** Point a built package's manifest at its emitted declarations, in place. */
async function repointManifest(pkgDir: string): Promise<void> {
	const manifestPath = path.join(pkgDir, "package.json");
	const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
	if (typeof manifest.types === "string") manifest.types = rewriteTypesPath(manifest.types);
	if (manifest.exports) manifest.exports = rewriteExports(manifest.exports);
	await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

function extractQuotedList(source: string, anchor: RegExp, label: string): string[] {
	const match = source.match(anchor);
	if (!match?.[1]) throw new Error(`Could not locate ${label}.`);
	return [...match[1].matchAll(/"([^"]+)"/g)].map(([, value]) => value);
}

function hasHiddenFlag(source: string): boolean {
	const match = source.match(/export interface (?:ModelRoleInfo|RoleInfo)\s*{([\s\S]*?)\n}/);
	if (!match?.[1]) throw new Error("Could not locate RoleInfo interface.");
	return /\bhidden\?:\s*boolean\b/.test(match[1]);
}

function diffList(actual: readonly string[], expected: readonly string[]): string {
	const missing = expected.filter(value => !actual.includes(value));
	const extra = actual.filter(value => !expected.includes(value));
	const problems: string[] = [];
	if (missing.length > 0) problems.push(`missing [${missing.join(", ")}]`);
	if (extra.length > 0) problems.push(`extra [${extra.join(", ")}]`);
	return problems.join("; ");
}

async function assertModelRoleShimParity(tmp: string): Promise<void> {
	const upstreamPath = path.join(tmp, "packages", "coding-agent", "src", "config", "model-roles.ts");
	const shimTsPath = path.join(repoRoot, "src", "shims", "model-roles.ts");
	const shimDtsPath = path.join(repoRoot, "src", "shims", "model-roles.d.ts");

	const [upstream, shimTs, shimDts] = await Promise.all([
		fs.readFile(upstreamPath, "utf8"),
		fs.readFile(shimTsPath, "utf8"),
		fs.readFile(shimDtsPath, "utf8"),
	]);

	const upstreamRoles = extractQuotedList(
		upstream,
		/export const MODEL_ROLE_IDS:[^{=\n]*=\s*\[([\s\S]*?)\];/,
		"upstream MODEL_ROLE_IDS",
	);
	const shimTsRoles = extractQuotedList(
		shimTs,
		/export const MODEL_ROLE_IDS:[^{=\n]*=\s*\[([\s\S]*?)\];/,
		"shim MODEL_ROLE_IDS",
	);
	const shimTsUnion = extractQuotedList(shimTs, /export type ModelRole\s*=([\s\S]*?);/, "shim ModelRole union");
	const shimDtsUnion = extractQuotedList(shimDts, /type ModelRole\s*=([\s\S]*?);/, "shim .d.ts ModelRole union");

	const problems: string[] = [];
	if (JSON.stringify(shimTsRoles) !== JSON.stringify(upstreamRoles)) {
		problems.push(`src/shims/model-roles.ts MODEL_ROLE_IDS: ${diffList(shimTsRoles, upstreamRoles)}`);
	}
	if (JSON.stringify(shimTsUnion) !== JSON.stringify(upstreamRoles)) {
		problems.push(`src/shims/model-roles.ts ModelRole union: ${diffList(shimTsUnion, upstreamRoles)}`);
	}
	if (JSON.stringify(shimDtsUnion) !== JSON.stringify(upstreamRoles)) {
		problems.push(`src/shims/model-roles.d.ts ModelRole union: ${diffList(shimDtsUnion, upstreamRoles)}`);
	}

	const upstreamHidden = hasHiddenFlag(upstream);
	const shimTsHidden = hasHiddenFlag(shimTs);
	const shimDtsHidden = hasHiddenFlag(shimDts);
	if (shimTsHidden !== upstreamHidden) {
		problems.push(
			`src/shims/model-roles.ts RoleInfo.hidden parity mismatch (upstream=${upstreamHidden}, local=${shimTsHidden})`,
		);
	}
	if (shimDtsHidden !== upstreamHidden) {
		problems.push(
			`src/shims/model-roles.d.ts RoleInfo.hidden parity mismatch (upstream=${upstreamHidden}, local=${shimDtsHidden})`,
		);
	}

	if (problems.length > 0) {
		throw new Error(`Local model-roles shim is stale versus omp ${ref}:\n- ${problems.join("\n- ")}`);
	}
}

async function main(): Promise<void> {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-head-"));
	/** `node_modules/@scope/<dir>` entries swapped out, for restore in `finally`. */
	const swapped: Array<{ live: string; backup: string }> = [];
	let tsconfigWritten = false;

	try {
		console.log(`Cloning ${repo}@${ref} …`);
		await $`git clone --depth 1 --branch ${ref} ${repo} ${tmp}`.quiet();

		console.log("Installing clone dependencies …");
		const frozen = await $`bun install --frozen-lockfile`.cwd(tmp).nothrow().quiet();
		if (frozen.exitCode !== 0) {
			console.log("Frozen install failed (lockfile drift) — retrying with a plain install …");
			await $`bun install`.cwd(tmp).quiet();
		}

		console.log("Checking local model-roles shim parity …");
		await assertModelRoleShimParity(tmp);

		const tsgoBin = path.join(tmp, "node_modules", ".bin", "tsgo");
		for (const pkg of HOST_PACKAGES) {
			const pkgDir = path.join(tmp, "packages", pkg);
			const publishConfig = path.join(pkgDir, "tsconfig.publish.json");
			if (!(await exists(publishConfig))) continue;
			console.log(`Emitting declarations for ${pkg} …`);
			await $`${tsgoBin} -p tsconfig.publish.json`.cwd(pkgDir).quiet();
			await repointManifest(pkgDir);
		}

		for (const { scope, dir } of SWAP_TARGETS) {
			const live = path.join(repoRoot, "node_modules", scope);
			const backup = `${live}.bak`;
			const clonePkg = path.join(tmp, "packages", dir);
			await fs.rename(live, backup);
			swapped.push({ live, backup });
			await fs.symlink(clonePkg, live, "dir");
		}

		await fs.writeFile(
			tmpTsconfig,
			`${JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { paths: {} } }, null, "\t")}\n`,
		);
		tsconfigWritten = true;

		console.log(`Typechecking against omp ${ref} …`);
		const result = await $`./node_modules/.bin/tsgo -p tsconfig.omp-head.json --noEmit`.cwd(repoRoot).nothrow();
		if (result.exitCode === 0) {
			console.log(`✓ plugin typechecks against omp ${ref}`);
		} else {
			console.error(`✗ plugin does NOT typecheck against omp ${ref}`);
		}
		process.exitCode = result.exitCode;
	} finally {
		for (const { live, backup } of swapped) {
			if (await exists(live)) await fs.rm(live, { force: true });
			if (await exists(backup)) await fs.rename(backup, live);
		}
		if (tsconfigWritten) await fs.rm(tmpTsconfig, { force: true });
		await fs.rm(tmp, { recursive: true, force: true });
	}
}

await main();
