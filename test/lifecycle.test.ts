/**
 * Full-lifecycle integration test: command dispatch → real on-disk store →
 * runtime override application.
 *
 * Drives the real `handleProfileCommand` dispatcher against a real
 * `ProfileStore` writing to a temp dir, using only headless verb forms (no
 * scripted `ctx.ui.select` pickers — that path is covered by `ui.test.ts`).
 *
 * Deliberately NOT covered here: a real-omp-process E2E of `/model-profile`.
 * Print mode (`packages/coding-agent/src/modes/print-mode.ts`) initializes
 * extensions but dispatches prompts to the model, not slash commands, and
 * interactive mode needs a TTY — so the command path cannot be driven
 * headlessly through the CLI. This test is the closest deterministic,
 * auth-free coverage of the wired flow.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { MODEL_ROLE_IDS } from "../src/shims/model-roles";
import { ProfileStore, STORE_FILENAME } from "../src/store";
import { handleProfileCommand } from "../src/ui";
import { testModel } from "./fixtures";

const available = [testModel("anthropic", "claude-opus-4-5")];

/** Record-backed settings fake covering the role-override + read-back surface
 * `verbSave`/`applyProfile`/`clearProfile` exercise. */
function makeSettings(initial: Record<string, string> = {}) {
	const base = { ...initial };
	const overrides: Record<string, string> = {};
	return {
		state: () => ({ base, overrides }),
		getModelRoles: () => ({ ...base, ...overrides }),
		getModelRole: (role: string) => ({ ...base, ...overrides })[role],
		get: (key: string) => (key === "cycleOrder" ? [] : undefined),
		overrideModelRoles: (roles: Record<string, string>) => {
			for (const [role, value] of Object.entries(roles)) if (value) overrides[role] = value;
		},
		override: () => {},
		clearOverride: (key: string) => {
			if (key === "modelRoles") for (const role of Object.keys(overrides)) delete overrides[role];
		},
	};
}

let root: string | undefined;

afterEach(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("model-profile command lifecycle", () => {
	test("save --project → switch → switch none → delete --project, with real on-disk JSON", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-life-"));
		const userDir = path.join(root, "user");
		const projectCwd = path.join(root, "project");
		const projectOmpDir = path.join(projectCwd, ".omp");
		await fs.mkdir(userDir, { recursive: true });
		await fs.mkdir(projectCwd, { recursive: true });

		const store = new ProfileStore(path.join(userDir, STORE_FILENAME), path.join(projectOmpDir, STORE_FILENAME));
		const projectFile = path.join(projectOmpDir, STORE_FILENAME);

		const settings = makeSettings({ default: "anthropic/claude-opus-4-5:high", task: "anthropic/claude-opus-4-5" });
		const pi = {
			pi: { settings, getAgentDir: () => userDir },
			setModel: async () => true,
			setThinkingLevel: () => {},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: projectCwd,
			hasUI: false,
			ui: { notify: () => {} },
			modelRegistry: {
				getAvailable: () => available,
				resolveCanonicalModel: () => available[0],
			},
		} as unknown as ExtensionCommandContext;

		// 1. save — snapshots the seeded role map into a new project-scoped profile.
		await handleProfileCommand(pi, ctx, "save deep --project", store);
		const afterSave = JSON.parse(await fs.readFile(projectFile, "utf8"));
		expect(afterSave.profiles.deep.modelRoles.default).toBe("anthropic/claude-opus-4-5:high");

		// 2. switch — activates the saved profile: overrides applied, active ref written.
		await handleProfileCommand(pi, ctx, "switch deep", store);
		expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5:high");
		const afterSwitch = JSON.parse(await fs.readFile(projectFile, "utf8"));
		expect(afterSwitch.active).toEqual({ name: "deep", scope: "project" });

		// 3. switch none — clears overrides and the active pointer.
		await handleProfileCommand(pi, ctx, "switch none", store);
		expect(settings.state().overrides).toEqual({});
		const afterClear = JSON.parse(await fs.readFile(projectFile, "utf8"));
		expect(afterClear.active).toBeUndefined();

		// 4. delete --project — removes the profile from disk.
		await handleProfileCommand(pi, ctx, "delete deep --project", store);
		const afterDelete = JSON.parse(await fs.readFile(projectFile, "utf8"));
		expect(afterDelete.profiles.deep).toBeUndefined();
	});

	test("switch none reapplies the global active profile after clearing a project override", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-life-"));
		const userDir = path.join(root, "user");
		const projectCwd = path.join(root, "project");
		const projectOmpDir = path.join(projectCwd, ".omp");
		await fs.mkdir(userDir, { recursive: true });
		await fs.mkdir(projectOmpDir, { recursive: true });

		const store = new ProfileStore(path.join(userDir, STORE_FILENAME), path.join(projectOmpDir, STORE_FILENAME));
		await store.saveProfile("global", "fallback", {
			modelRoles: { default: "anthropic/claude-opus-4-5:high" },
		});
		await store.setActive("global", { name: "fallback", scope: "global" });
		await store.saveProfile("project", "project-fast", {
			modelRoles: { default: "anthropic/claude-opus-4-5:minimal" },
		});

		const settings = makeSettings();
		const pi = {
			pi: { settings, getAgentDir: () => userDir },
			setModel: async () => true,
			setThinkingLevel: () => {},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: projectCwd,
			hasUI: false,
			ui: { notify: () => {} },
			modelRegistry: {
				getAvailable: () => available,
				resolveCanonicalModel: () => available[0],
			},
		} as unknown as ExtensionCommandContext;

		await handleProfileCommand(pi, ctx, "switch project-fast", store);
		expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5:minimal");

		await handleProfileCommand(pi, ctx, "switch none", store);
		expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5:high");
		expect((await store.loadEffective()).active).toEqual({ name: "fallback", scope: "global" });
	});

	test("deleting a global profile clears a project ref to it and reapplies the global fallback", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-life-"));
		const userDir = path.join(root, "user");
		const projectCwd = path.join(root, "project");
		const projectOmpDir = path.join(projectCwd, ".omp");
		await fs.mkdir(userDir, { recursive: true });
		await fs.mkdir(projectOmpDir, { recursive: true });

		const store = new ProfileStore(path.join(userDir, STORE_FILENAME), path.join(projectOmpDir, STORE_FILENAME));
		await store.saveProfile("global", "fallback", {
			modelRoles: { default: "anthropic/claude-opus-4-5:high" },
		});
		await store.saveProfile("global", "shared", {
			modelRoles: { default: "anthropic/claude-opus-4-5:minimal" },
		});
		await store.setActive("global", { name: "fallback", scope: "global" });
		await store.setActive("project", { name: "shared", scope: "global" });

		const settings = makeSettings();
		const pi = {
			pi: { settings, getAgentDir: () => userDir },
			setModel: async () => true,
			setThinkingLevel: () => {},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: projectCwd,
			hasUI: false,
			ui: { notify: () => {} },
			modelRegistry: {
				getAvailable: () => available,
				resolveCanonicalModel: () => available[0],
			},
		} as unknown as ExtensionCommandContext;

		await handleProfileCommand(pi, ctx, "switch shared --global", store);
		expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5:minimal");

		await handleProfileCommand(pi, ctx, "delete shared --global", store);
		expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5:high");
		expect(await store.readScope("project")).toEqual({ profiles: {} });
	});

	test("use alias reports its own usage text in headless mode", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-life-"));
		const userDir = path.join(root, "user");
		const projectCwd = path.join(root, "project");
		const projectOmpDir = path.join(projectCwd, ".omp");
		await fs.mkdir(userDir, { recursive: true });
		await fs.mkdir(projectOmpDir, { recursive: true });

		const store = new ProfileStore(path.join(userDir, STORE_FILENAME), path.join(projectOmpDir, STORE_FILENAME));
		const notifications: string[] = [];
		const pi = {
			pi: { settings: makeSettings(), getAgentDir: () => userDir },
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: projectCwd,
			hasUI: false,
			ui: { notify: (message: string) => notifications.push(message) },
		} as unknown as ExtensionCommandContext;

		await handleProfileCommand(pi, ctx, "use", store);
		expect(notifications[0]).toBe("Usage: /model-profile use <name|none>");
	});

	test("interactive create can save directly to the global profile store", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-life-"));
		const userDir = path.join(root, "user");
		const projectCwd = path.join(root, "project");
		const projectOmpDir = path.join(projectCwd, ".omp");
		await fs.mkdir(userDir, { recursive: true });
		await fs.mkdir(projectOmpDir, { recursive: true });

		const store = new ProfileStore(path.join(userDir, STORE_FILENAME), path.join(projectOmpDir, STORE_FILENAME));
		const globalFile = path.join(userDir, STORE_FILENAME);
		const projectFile = path.join(projectOmpDir, STORE_FILENAME);
		const settings = makeSettings();
		const pi = {
			pi: { settings, getAgentDir: () => userDir },
			setModel: async () => true,
			setThinkingLevel: () => {},
		} as unknown as ExtensionAPI;
		const picks = ["Global", ...MODEL_ROLE_IDS.map(() => "— skip —")];
		const ctx = {
			cwd: projectCwd,
			hasUI: true,
			ui: {
				select: async () => picks.shift(),
				input: async (_title: string, placeholder: string) => (placeholder === "" ? "" : undefined),
				confirm: async () => false,
				notify: () => {},
			},
			modelRegistry: {
				getAvailable: () => available,
				resolveCanonicalModel: () => available[0],
			},
		} as unknown as ExtensionCommandContext;

		await handleProfileCommand(pi, ctx, "create global-empty", store);
		expect(await fs.readFile(globalFile, "utf8")).toContain('"global-empty"');
		await expect(fs.readFile(projectFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("switch can target the global profile even when a project profile shadows the name", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-life-"));
		const userDir = path.join(root, "user");
		const projectCwd = path.join(root, "project");
		const projectOmpDir = path.join(projectCwd, ".omp");
		await fs.mkdir(userDir, { recursive: true });
		await fs.mkdir(projectOmpDir, { recursive: true });

		const store = new ProfileStore(path.join(userDir, STORE_FILENAME), path.join(projectOmpDir, STORE_FILENAME));
		const projectFile = path.join(projectOmpDir, STORE_FILENAME);
		await store.saveProfile("global", "shared", {
			modelRoles: { default: "anthropic/claude-opus-4-5:high" },
		});
		await store.saveProfile("project", "shared", {
			modelRoles: { default: "anthropic/claude-opus-4-5:minimal" },
		});

		const settings = makeSettings();
		const pi = {
			pi: { settings, getAgentDir: () => userDir },
			setModel: async () => true,
			setThinkingLevel: () => {},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: projectCwd,
			hasUI: false,
			ui: { notify: () => {} },
			modelRegistry: {
				getAvailable: () => available,
				resolveCanonicalModel: () => available[0],
			},
		} as unknown as ExtensionCommandContext;

		await handleProfileCommand(pi, ctx, "switch shared", store);
		expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5:minimal");
		expect(JSON.parse(await fs.readFile(projectFile, "utf8")).active).toEqual({ name: "shared", scope: "project" });

		await handleProfileCommand(pi, ctx, "switch shared --global", store);
		expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5:high");
		expect(JSON.parse(await fs.readFile(projectFile, "utf8")).active).toEqual({ name: "shared", scope: "global" });
	});
});
