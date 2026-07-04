import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import modelProfilesExtension from "../src/index";
import { ProfileStore, STORE_FILENAME } from "../src/store";

let root: string | undefined;

afterEach(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("model profiles extension factory", () => {
	test("registers the profile command and session_start hook", () => {
		const registeredEvents: string[] = [];
		let label: string | undefined;
		let commandName: string | undefined;
		let commandDescription: string | undefined;
		let completions: ((argumentPrefix: string) => unknown) | undefined;
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;

		const fakePi = {
			setLabel(next: string) {
				label = next;
			},
			on(event: string) {
				registeredEvents.push(event);
			},
			registerCommand(
				name: string,
				options: {
					description?: string;
					getArgumentCompletions?: (argumentPrefix: string) => unknown;
					handler: (args: string, ctx: unknown) => Promise<void>;
				},
			) {
				commandName = name;
				commandDescription = options.description;
				completions = options.getArgumentCompletions;
				handler = options.handler;
			},
		} as unknown as ExtensionAPI;

		modelProfilesExtension(fakePi);

		expect(label).toBe("Model Profiles");
		expect(registeredEvents).toContain("session_start");
		expect(commandName).toBe("model-profile");
		expect(commandDescription).toBe("Manage global and project model profiles");
		expect(completions?.("")).toEqual([
			{ label: "switch", value: "switch" },
			{ label: "use", value: "use" },
			{ label: "show", value: "show" },
			{ label: "create", value: "create" },
			{ label: "save", value: "save" },
			{ label: "edit", value: "edit" },
			{ label: "delete", value: "delete" },
			{ label: "list", value: "list" },
			{ label: "help", value: "help" },
		]);
		expect(handler).toBeDefined();
	});

	test("filters switch completions for the --user alias", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "mp-factory-"));
		const userDir = path.join(root, "user");
		const projectCwd = path.join(root, "project");
		await fs.mkdir(userDir, { recursive: true });
		await fs.mkdir(path.join(projectCwd, ".omp"), { recursive: true });

		const store = new ProfileStore(path.join(userDir, STORE_FILENAME), path.join(projectCwd, ".omp", STORE_FILENAME));
		await store.saveProfile("global", "g-shared", { modelRoles: { default: "anthropic/claude-opus-4-5" } });
		await store.saveProfile("project", "g-shadow", { modelRoles: { default: "anthropic/claude-opus-4-5:minimal" } });

		let completions: ((argumentPrefix: string) => unknown) | undefined;
		let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
		const fakePi = {
			pi: { getAgentDir: () => userDir },
			setLabel() {},
			on() {},
			registerCommand(
				_name: string,
				options: {
					getArgumentCompletions?: (argumentPrefix: string) => unknown;
					handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
				},
			) {
				completions = options.getArgumentCompletions;
				handler = options.handler;
			},
		} as unknown as ExtensionAPI;

		modelProfilesExtension(fakePi);
		const ctx = {
			cwd: projectCwd,
			hasUI: false,
			ui: { notify: () => {} },
		} as unknown as ExtensionCommandContext;
		await handler?.("list", ctx);

		expect(completions?.("switch g --user")).toEqual([
			{ label: "g-shared [global]", value: "switch g-shared --global", description: "global" },
		]);
	});
});
