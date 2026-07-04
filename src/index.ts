/** Standalone omp extension entrypoint for named model profiles. */
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { applyProfile } from "./runtime";
import { ProfileStore, STORE_FILENAME } from "./store";
import type { EffectiveProfiles, ProfileScope } from "./types";
import { handleProfileCommand } from "./ui";

const VERBS = ["switch", "use", "show", "create", "save", "edit", "delete", "list", "help"] as const;

function createStore(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "cwd">): ProfileStore {
	return new ProfileStore(path.join(pi.pi.getAgentDir(), STORE_FILENAME), path.join(ctx.cwd, ".omp", STORE_FILENAME));
}

function isScopeMatch(scope: ProfileScope | undefined, expected: ProfileScope): boolean {
	return scope === undefined || scope === expected;
}

function profileCompletions(argumentPrefix: string, effective: EffectiveProfiles | undefined) {
	const trimmed = argumentPrefix.trimStart();
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	if (tokens.length <= 1 && !trimmed.endsWith(" ")) {
		const query = (tokens[0] ?? "").toLowerCase();
		return VERBS.filter(verb => verb.startsWith(query)).map(verb => ({ label: verb, value: verb }));
	}

	const verb = tokens[0] ?? "";
	if (verb !== "switch" && verb !== "use" && verb !== "show" && verb !== "edit" && verb !== "delete") return null;
	const query = (tokens[1] ?? "").toLowerCase();
	const explicitScope =
		tokens.includes("--global") ||
		tokens.includes("--user") ||
		(tokens.includes("--scope") &&
			(tokens[tokens.indexOf("--scope") + 1] === "global" || tokens[tokens.indexOf("--scope") + 1] === "user"))
			? "global"
			: tokens.includes("--project") ||
					(tokens.includes("--scope") && tokens[tokens.indexOf("--scope") + 1] === "project")
				? "project"
				: undefined;
	const items =
		effective?.entries
			.filter(entry => isScopeMatch(explicitScope, entry.scope) && entry.name.toLowerCase().startsWith(query))
			.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope))
			.map(entry => ({
				label: `${entry.name} [${entry.scope}]`,
				value: `${verb} ${entry.name}${entry.scope === "global" ? " --global" : ""}`,
				description:
					effective.active?.name === entry.name && effective.active.scope === entry.scope ? "active" : entry.scope,
			})) ?? [];
	if ((verb === "switch" || verb === "use") && "none".startsWith(query))
		items.unshift({ label: "none", value: `${verb} none`, description: "clear project override" });
	return items.length ? items : null;
}

export default function modelProfilesExtension(pi: ExtensionAPI): void {
	pi.setLabel("Model Profiles");

	let cachedEffective: EffectiveProfiles | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const store = createStore(pi, ctx);
		cachedEffective = await store.loadEffective();
		const active = cachedEffective.active;
		const profile = cachedEffective.activeProfile;
		if (!active || !profile) return;
		await applyProfile(pi, ctx, active.name, profile);
	});

	pi.registerCommand("model-profile", {
		description: "Manage global and project model profiles",
		getArgumentCompletions: argumentPrefix => profileCompletions(argumentPrefix, cachedEffective),
		handler: async (args, ctx) => {
			const store = createStore(pi, ctx);
			cachedEffective = await handleProfileCommand(pi, ctx, args, store);
		},
	});
}
