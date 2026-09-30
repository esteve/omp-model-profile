/**
 * Interactive flows and the `/model-profile` command dispatcher.
 *
 * Every picker is gated on `ctx.hasUI`; with explicit arguments the
 * non-interactive verbs (`switch`, `show`, `delete`, `list`) work headless.
 * Pickers are Level-1 `ctx.ui.select` menus — no model names are ever typed.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getRoleInfo, MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { type ProfileModel, resolveCanonicalFromRegistry, resolveCompatibleModelString } from "./apply";
import { type GenerateSpec, generateProfile } from "./generate";
import { applyProfile, clearProfile } from "./runtime";
import type { ProfileStore } from "./store";
import type { EffectiveProfiles, ModelProfile, ProfileRef, ProfileScope } from "./types";

type SelectOption = { label: string; description?: string };
type ModelPick = ProfileModel | "skip" | "cancel";
type ProfileSelection = ProfileRef | "none";
interface ResolvedProfile {
	ref: ProfileRef;
	profile: ModelProfile;
}

const THINKING_OPTIONS: readonly string[] = ["default", "auto", "minimal", "low", "medium", "high", "xhigh"];
const NAME_PATTERN = /^[\w.-]+$/;

interface ParsedArgs {
	verb: string;
	name: string | undefined;
	scope: ProfileScope | undefined;
	/** Positional tokens after the name, joined — used as the `generate` prompt. */
	rest: string;
}

/** Split `args` into a verb, an optional name, and an optional explicit scope. */
function parseArgs(args: string): ParsedArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let scope: ProfileScope | undefined;
	const positional: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--user" || token === "--global") {
			scope = "global";
		} else if (token === "--project") {
			scope = "project";
		} else if (token === "--scope") {
			const next = tokens[i + 1]?.toLowerCase();
			if (next === "user" || next === "global") {
				scope = "global";
				i++;
			} else if (next === "project") {
				scope = "project";
				i++;
			}
		} else {
			positional.push(token);
		}
	}
	return {
		verb: (positional[0] ?? "").toLowerCase(),
		name: positional[1],
		scope,
		rest: positional.slice(2).join(" "),
	};
}
function roleLabel(pi: ExtensionAPI, role: string): string {
	return getRoleInfo(role, pi.pi.settings).name;
}

function modelLabel(model: ProfileModel): string {
	return `${model.provider}/${model.id}`;
}

function isModelAvailable(ctx: ExtensionContext, value: string, available: readonly ProfileModel[]): boolean {
	return (
		resolveCompatibleModelString(value, available, id => resolveCanonicalFromRegistry(ctx.modelRegistry, id)) !==
		undefined
	);
}

function scopeProfiles(effective: EffectiveProfiles, scope: ProfileScope): Record<string, ModelProfile> {
	return scope === "global" ? effective.globalProfiles : effective.projectProfiles;
}

function refsEqual(a: ProfileRef | undefined, b: ProfileRef | undefined): boolean {
	return a?.name === b?.name && a?.scope === b?.scope;
}

function compareRefs(a: ProfileRef, b: ProfileRef): number {
	return a.name.localeCompare(b.name) || (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1);
}

function formatProfileLabel(ref: ProfileRef): string {
	return `${ref.name} [${ref.scope}]`;
}

function resolveProfile(
	effective: EffectiveProfiles,
	name: string,
	scope: ProfileScope | undefined,
): ResolvedProfile | undefined {
	if (scope) {
		const profile = scopeProfiles(effective, scope)[name];
		return profile ? { ref: { name, scope }, profile } : undefined;
	}
	const project = effective.projectProfiles[name];
	if (project) return { ref: { name, scope: "project" }, profile: project };
	const global = effective.globalProfiles[name];
	return global ? { ref: { name, scope: "global" }, profile: global } : undefined;
}

/** Coerce a free-form name into a valid profile name, or undefined if none survives. */
export function slugifyName(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const slug = raw
		.trim()
		.toLowerCase()
		.replace(/[^\w.-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-._]+|[-._]+$/g, "");
	return slug && NAME_PATTERN.test(slug) ? slug : undefined;
}

/** Built-in roles (with values, unless `includeAllBuiltins`) then custom extras. */
function orderedRoles(_pi: ExtensionAPI, profile: ModelProfile, includeAllBuiltins: boolean): string[] {
	const builtins = MODEL_ROLE_IDS;
	const builtinSet = new Set<string>(builtins);
	const roles: string[] = [];
	for (const role of builtins) {
		if (includeAllBuiltins || profile.modelRoles[role]) roles.push(role);
	}
	for (const role of Object.keys(profile.modelRoles)) {
		if (!builtinSet.has(role)) roles.push(role);
	}
	return roles;
}

// ───────────────────────────────────────────────────────────────────────────
// Pickers (interactive only)
// ───────────────────────────────────────────────────────────────────────────

async function pickProfile(
	ctx: ExtensionContext,
	effective: EffectiveProfiles,
	opts: { allowNone?: boolean; preselectActive?: boolean },
): Promise<ProfileSelection | undefined> {
	const entries = [...effective.entries].sort((a, b) => compareRefs(a, b));
	if (entries.length === 0 && !opts.allowNone) {
		ctx.ui.notify("No model profiles defined yet. Create one with /model-profile create <name>.", "info");
		return undefined;
	}

	const byLabel = new Map<string, ProfileRef>();
	const options: SelectOption[] = [];
	if (opts.allowNone) options.push({ label: "none", description: "Clear the active project override" });
	for (const entry of entries) {
		const active = refsEqual(effective.active, entry) ? " (active)" : "";
		const desc = entry.profile.description ? ` — ${entry.profile.description}` : "";
		const label = formatProfileLabel(entry);
		byLabel.set(label, { name: entry.name, scope: entry.scope });
		options.push({ label, description: `${entry.scope}${desc}${active}` });
	}

	let initialIndex = 0;
	if (opts.preselectActive && effective.active) {
		const idx = options.findIndex(option => option.label === formatProfileLabel(effective.active as ProfileRef));
		if (idx >= 0) initialIndex = idx;
	}

	const chosen = await ctx.ui.select("Select a profile", options, { initialIndex, selectionMarker: "radio" });
	if (!chosen) return undefined;
	return chosen === "none" ? "none" : byLabel.get(chosen);
}

export async function pickWriteScope(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	explicitScope: ProfileScope | undefined,
	mode: "create" | "generate",
): Promise<ProfileScope | undefined> {
	if (explicitScope) return explicitScope;
	if (!ctx.hasUI) return "project";
	const chosen = await ctx.ui.select(
		mode === "generate" ? "Where should the generated profile live?" : "Where should this profile live?",
		[
			{ label: "Project", description: "Stored in .omp/model-profiles.json" },
			{ label: "Global", description: "Stored in ~/.omp/agent/model-profiles.json" },
		],
		{ initialIndex: 0, selectionMarker: "radio" },
	);
	return chosen === "Global" ? "global" : chosen === "Project" ? "project" : undefined;
}

async function pickRole(pi: ExtensionAPI, ctx: ExtensionContext, profile: ModelProfile): Promise<string | undefined> {
	const roles = orderedRoles(pi, profile, true);
	const byLabel = new Map<string, string>();
	const options: SelectOption[] = roles.map(role => {
		const label = `${roleLabel(pi, role)} (${role})`;
		byLabel.set(label, role);
		return { label, description: profile.modelRoles[role] ?? "unset" };
	});
	const chosen = await ctx.ui.select("Pick a role to edit", options);
	return chosen ? byLabel.get(chosen) : undefined;
}

export async function pickModel(
	ctx: ExtensionContext,
	available: readonly ProfileModel[],
	title: string,
): Promise<ModelPick> {
	if (available.length === 0) {
		ctx.ui.notify("No models available — configure an API key first.", "warning");
		return "skip";
	}
	// Provider "tabs": `All` plus each distinct provider, switched with ←/→.
	// The same model id is often served by multiple providers, so the provider
	// is part of the selection key — jump to a provider, then type-to-filter.
	const providers = ["All", ...[...new Set(available.map(model => model.provider))].sort()];
	const multiProvider = providers.length > 2;
	let tab = 0;
	for (;;) {
		const provider = providers[tab];
		const pool = provider === "All" ? available : available.filter(model => model.provider === provider);
		const sorted = [...pool].sort((a, b) => modelLabel(a).localeCompare(modelLabel(b)));
		const byLabel = new Map<string, ProfileModel>();
		const options: SelectOption[] = [{ label: "— skip —", description: "Leave this role unset" }];
		for (const model of sorted) {
			const label = modelLabel(model);
			byLabel.set(label, model);
			options.push({ label, description: model.name });
		}
		const tabHint = multiProvider ? `  ·  ${provider} (${tab + 1}/${providers.length})` : "";
		let moved: -1 | 1 | undefined;
		const chosen = await ctx.ui.select(`${title}${tabHint}`, options, {
			helpText: multiProvider
				? "↑↓ select · type to filter · ←→ provider · enter confirm"
				: "↑↓ select · type to filter · enter confirm",
			onLeft: multiProvider
				? () => {
						moved = -1;
					}
				: undefined,
			onRight: multiProvider
				? () => {
						moved = 1;
					}
				: undefined,
		});
		if (moved !== undefined) {
			tab = (tab + moved + providers.length) % providers.length;
			continue;
		}
		if (chosen === undefined) return "cancel";
		const model = byLabel.get(chosen);
		return model ?? "skip";
	}
}

/**
 * Returns the chosen level, `""` for model default (or cancel). `auto` is only
 * offered when `allowAuto` is set — it is a session-only selector that the host
 * applies to the live model, so it is meaningful for the `default` role only.
 */
async function pickThinking(ctx: ExtensionContext, roleName: string, allowAuto: boolean): Promise<string> {
	const options = allowAuto ? THINKING_OPTIONS : THINKING_OPTIONS.filter(level => level !== "auto");
	const chosen = await ctx.ui.select(`Thinking level for ${roleName}`, [...options]);
	return !chosen || chosen === "default" ? "" : chosen;
}

// ───────────────────────────────────────────────────────────────────────────
// Output
// ───────────────────────────────────────────────────────────────────────────

function listProfiles(ctx: ExtensionContext, effective: EffectiveProfiles): void {
	const entries = [...effective.entries].sort((a, b) => compareRefs(a, b));
	if (entries.length === 0) {
		ctx.ui.notify("No model profiles defined. Create one with /model-profile create <name>.", "info");
		return;
	}
	const lines = ["Model profiles:"];
	for (const entry of entries) {
		const marker = refsEqual(effective.active, entry) ? "●" : " ";
		const desc = entry.profile.description ? ` — ${entry.profile.description}` : "";
		lines.push(`  ${marker} ${entry.name} [${entry.scope}]${desc}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

function showProfile(pi: ExtensionAPI, ctx: ExtensionContext, selected: ResolvedProfile): void {
	const { ref, profile } = selected;
	const available = ctx.modelRegistry.getAvailable();
	const lines = [`Profile "${ref.name}" [${ref.scope}]`];
	if (profile.description) lines.push(profile.description);
	lines.push("");

	const roles = orderedRoles(pi, profile, false);
	if (roles.length === 0) {
		lines.push("  (no roles set — /model-profile edit to add models)");
	} else {
		for (const role of roles) {
			const value = profile.modelRoles[role];
			if (!value) continue;
			const mark = isModelAvailable(ctx, value, available) ? "✓" : "✗";
			lines.push(`  ${mark} ${roleLabel(pi, role)} (${role}): ${value}`);
		}
	}

	if (profile.cycleOrder?.length) lines.push("", `  cycle: ${profile.cycleOrder.join(" → ")}`);
	if (profile.taskAgentModelOverrides) {
		lines.push("", "  subagent overrides:");
		for (const [agent, model] of Object.entries(profile.taskAgentModelOverrides)) {
			lines.push(`    ${agent}: ${model}`);
		}
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

async function applyCurrentEffectiveProfile(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	effective: EffectiveProfiles,
): Promise<void> {
	if (effective.active && effective.activeProfile) {
		await applyProfile(pi, ctx, effective.active.name, effective.activeProfile);
		return;
	}
	await clearProfile(pi, ctx);
}

// ───────────────────────────────────────────────────────────────────────────
// Verbs
// ───────────────────────────────────────────────────────────────────────────

async function verbSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: ProfileStore,
	effective: EffectiveProfiles,
	command: "switch" | "use",
	name: string | undefined,
	scope: ProfileScope | undefined,
): Promise<void> {
	let target: ProfileSelection | undefined;
	if (!name) {
		if (!ctx.hasUI) {
			ctx.ui.notify(`Usage: /model-profile ${command} <name|none>`, "error");
			return;
		}
		target = await pickProfile(ctx, effective, { allowNone: true, preselectActive: true });
		if (target === undefined) return;
	} else if (name === "none") {
		target = "none";
	} else {
		target = resolveProfile(effective, name, scope)?.ref;
	}

	if (target === "none") {
		await store.setActive("project", undefined);
		const next = await store.loadEffective();
		await applyCurrentEffectiveProfile(pi, ctx, next);
		if (next.active) {
			ctx.ui.notify(`Switched to profile "${next.active.name}" [${next.active.scope}].`, "info");
		} else {
			ctx.ui.notify("Model profile cleared.", "info");
		}
		return;
	}
	if (!target) {
		ctx.ui.notify(`Profile "${name}"${scope ? ` not found in ${scope}` : " not found"}.`, "error");
		return;
	}

	const selected = resolveProfile(effective, target.name, target.scope);
	if (!selected) {
		ctx.ui.notify(`Profile "${target.name}" not found in ${target.scope}.`, "error");
		return;
	}
	await store.setActive("project", selected.ref);
	await applyProfile(pi, ctx, selected.ref.name, selected.profile);
	ctx.ui.notify(`Switched to profile "${selected.ref.name}" [${selected.ref.scope}].`, "info");
}

async function verbCreate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: ProfileStore,
	effective: EffectiveProfiles,
	name: string | undefined,
	scope: ProfileScope | undefined,
): Promise<void> {
	const writeScope = await pickWriteScope(ctx, scope, "create");
	if (!writeScope) return;
	let target = name;
	if (!target) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Usage: /model-profile create <name>", "error");
			return;
		}
		target = (await ctx.ui.input("New profile name", "e.g. deep-review"))?.trim();
		if (!target) return;
	}
	if (!NAME_PATTERN.test(target)) {
		ctx.ui.notify(`Invalid profile name "${target}" (use letters, digits, ".", "-", "_").`, "error");
		return;
	}

	if (!ctx.hasUI) {
		await store.saveProfile(writeScope, target, { modelRoles: {} });
		ctx.ui.notify(
			`Created empty profile "${target}" [${writeScope}]. Edit it interactively with /model-profile edit ${target}.`,
			"info",
		);
		return;
	}

	if (
		scopeProfiles(effective, writeScope)[target] &&
		!(await ctx.ui.confirm("Profile exists", `Overwrite "${target}" in ${writeScope}?`))
	) {
		return;
	}

	const available = ctx.modelRegistry.getAvailable();
	const modelRoles: Record<string, string> = {};
	for (const role of MODEL_ROLE_IDS) {
		const label = roleLabel(pi, role);
		const pick = await pickModel(ctx, available, `Model for ${label} (${role})`);
		if (pick === "cancel") return;
		if (pick === "skip") continue;
		let value = modelLabel(pick);
		const level = await pickThinking(ctx, label, role === "default");
		if (level) value += `:${level}`;
		modelRoles[role] = value;
	}

	const profile: ModelProfile = { modelRoles };
	const description = (await ctx.ui.input("Description (optional)", ""))?.trim();
	if (description) profile.description = description;

	await store.saveProfile(writeScope, target, profile);
	if (await ctx.ui.confirm("Activate?", `Switch to "${target}" [${writeScope}] now?`)) {
		await store.setActive("project", { name: target, scope: writeScope });
		await applyProfile(pi, ctx, target, profile);
	}
	ctx.ui.notify(`Saved profile "${target}" [${writeScope}].`, "info");
}

async function verbSave(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: ProfileStore,
	effective: EffectiveProfiles,
	name: string | undefined,
	scope: ProfileScope | undefined,
): Promise<void> {
	const writeScope = scope ?? "project";
	let target = name;
	if (!target) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Usage: /model-profile save <name>", "error");
			return;
		}
		target = (await ctx.ui.input("Save current models as profile", "name"))?.trim();
		if (!target) return;
	}
	if (!NAME_PATTERN.test(target)) {
		ctx.ui.notify(`Invalid profile name "${target}" (use letters, digits, ".", "-", "_").`, "error");
		return;
	}

	const s = pi.pi.settings;
	const builtins = new Set<string>(MODEL_ROLE_IDS);
	const modelRoles: Record<string, string> = {};
	for (const [role, value] of Object.entries(s.getModelRoles())) {
		if (builtins.has(role) && value) modelRoles[role] = value;
	}

	const profile: ModelProfile = { modelRoles };
	const cycleOrder = lookup("cycleOrder")?.get(s);
	if (Array.isArray(cycleOrder) && cycleOrder.every(value => typeof value === "string"))
		profile.cycleOrder = cycleOrder;
	const taskOverrides = lookup("task.agentModelOverrides")?.get(s);
	if (taskOverrides && typeof taskOverrides === "object" && !Array.isArray(taskOverrides))
		profile.taskAgentModelOverrides = { ...taskOverrides } as Record<string, string>;
	const existing = scopeProfiles(effective, writeScope)[target];
	if (existing?.description) profile.description = existing.description;

	await store.saveProfile(writeScope, target, profile);
	ctx.ui.notify(`Saved current models as profile "${target}" [${writeScope}].`, "info");
}

async function verbEdit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: ProfileStore,
	effective: EffectiveProfiles,
	name: string | undefined,
	scope: ProfileScope | undefined,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Editing requires interactive UI.", "error");
		return;
	}

	let selected: ResolvedProfile | undefined;
	if (!name) {
		const picked = await pickProfile(ctx, effective, {});
		if (!picked || picked === "none") return;
		selected = resolveProfile(effective, picked.name, picked.scope);
	} else {
		selected = resolveProfile(effective, name, scope);
	}
	if (!selected) {
		ctx.ui.notify(`Profile "${name}"${scope ? ` not found in ${scope}` : " not found"}.`, "error");
		return;
	}

	const role = await pickRole(pi, ctx, selected.profile);
	if (!role) return;
	const available = ctx.modelRegistry.getAvailable();
	const pick = await pickModel(ctx, available, `Model for ${roleLabel(pi, role)} (${role})`);
	if (pick === "cancel") return;

	const updated: ModelProfile = { ...selected.profile, modelRoles: { ...selected.profile.modelRoles } };
	if (pick === "skip") {
		delete updated.modelRoles[role];
	} else {
		let value = modelLabel(pick);
		const level = await pickThinking(ctx, roleLabel(pi, role), role === "default");
		if (level) value += `:${level}`;
		updated.modelRoles[role] = value;
	}

	await store.saveProfile(selected.ref.scope, selected.ref.name, updated);
	if (refsEqual(effective.active, selected.ref)) await applyProfile(pi, ctx, selected.ref.name, updated);
	ctx.ui.notify(`Updated "${selected.ref.name}" [${selected.ref.scope}] → ${role}.`, "info");
}

async function verbGenerate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: ProfileStore,
	effective: EffectiveProfiles,
	name: string | undefined,
	scope: ProfileScope | undefined,
	prompt: string,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Generate requires interactive UI. Usage: /model-profile generate [name] <prompt>", "error");
		return;
	}
	const writeScope = await pickWriteScope(ctx, scope, "generate");
	if (!writeScope) return;

	// Name is optional — a blank name lets the model propose one.
	let target = name?.trim() || undefined;
	if (!target) {
		const entered = (
			await ctx.ui.input("Profile name (optional — blank lets the AI name it)", "e.g. anthropic-stack")
		)?.trim();
		target = entered || undefined;
	}
	if (target && !NAME_PATTERN.test(target)) {
		ctx.ui.notify(`Invalid profile name "${target}" (use letters, digits, ".", "-", "_").`, "error");
		return;
	}
	if (
		target &&
		scopeProfiles(effective, writeScope)[target] &&
		!(await ctx.ui.confirm("Profile exists", `Overwrite "${target}" in ${writeScope}?`))
	) {
		return;
	}

	let intent = prompt.trim();
	if (!intent) {
		intent = (await ctx.ui.input("Describe the profile", "e.g. fast OpenAI models for everything"))?.trim() ?? "";
		if (!intent) return;
	}

	const available = ctx.modelRegistry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify("No models available — configure an API key first.", "warning");
		return;
	}
	let model = ctx.model;
	if (!model) {
		const pick = await pickModel(ctx, available, "Pick a model to generate with");
		if (pick === "cancel" || pick === "skip") return;
		model = pick;
	}
	const apiKey = await ctx.modelRegistry.getApiKey(model);
	if (!apiKey) {
		ctx.ui.notify(`No API key available for ${modelLabel(model)}.`, "error");
		return;
	}

	const roleIds = MODEL_ROLE_IDS;
	const roleDescriptions: Record<string, string> = {};
	for (const role of roleIds) roleDescriptions[role] = roleLabel(pi, role);
	const spec: GenerateSpec = {
		roleIds,
		roleDescriptions,
		available,
		resolveCanonical: id =>
			resolveCompatibleModelString(id, available, canonicalId =>
				resolveCanonicalFromRegistry(ctx.modelRegistry, canonicalId),
			),
		thinkingLevels: THINKING_OPTIONS,
	};

	ctx.ui.setStatus("model-profile-gen", `Generating profile with ${modelLabel(model)}…`);
	let profile: ModelProfile;
	let warnings: string[];
	let suggestedName: string | undefined;
	try {
		({ profile, warnings, suggestedName } = await generateProfile(model, apiKey, intent, spec));
	} catch (err) {
		ctx.ui.notify(`Generation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	} finally {
		ctx.ui.setStatus("model-profile-gen", undefined);
	}

	if (!profile.modelRoles.default) {
		ctx.ui.notify("Generation did not assign a default model — try a more specific prompt.", "error");
		return;
	}
	if (warnings.length > 0) {
		ctx.ui.notify(`Generation notes:\n${warnings.map(w => `  • ${w}`).join("\n")}`, "warning");
	}

	// Final name: the user's choice wins; otherwise the model's suggestion;
	// otherwise ask once as a fallback.
	let finalName = target;
	if (!finalName) {
		finalName = slugifyName(suggestedName);
		if (!finalName) {
			finalName = (await ctx.ui.input("Name this profile", "e.g. generated"))?.trim() || undefined;
		}
		if (!finalName || !NAME_PATTERN.test(finalName)) {
			ctx.ui.notify("No valid profile name — aborting.", "error");
			return;
		}
		if (
			scopeProfiles(effective, writeScope)[finalName] &&
			!(await ctx.ui.confirm("Profile exists", `Overwrite "${finalName}" in ${writeScope}?`))
		) {
			return;
		}
	}

	await store.saveProfile(writeScope, finalName, profile);
	let view = await store.loadEffective();
	const saved = resolveProfile(view, finalName, writeScope);
	if (saved) showProfile(pi, ctx, saved);

	while (await ctx.ui.confirm("Refine?", `Edit a role in "${finalName}" [${writeScope}] before activating?`)) {
		await verbEdit(pi, ctx, store, view, finalName, writeScope);
		view = await store.loadEffective();
	}

	if (await ctx.ui.confirm("Activate?", `Switch to "${finalName}" [${writeScope}] now?`)) {
		await store.setActive("project", { name: finalName, scope: writeScope });
		const selected = resolveProfile(view, finalName, writeScope);
		if (selected) await applyProfile(pi, ctx, finalName, selected.profile);
	}
	ctx.ui.notify(`Saved profile "${finalName}" [${writeScope}].`, "info");
}

async function verbDelete(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: ProfileStore,
	effective: EffectiveProfiles,
	name: string | undefined,
	scope: ProfileScope | undefined,
): Promise<void> {
	let selected: ResolvedProfile | undefined;
	if (!name) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Usage: /model-profile delete <name>", "error");
			return;
		}
		const picked = await pickProfile(ctx, effective, {});
		if (!picked || picked === "none") return;
		selected = resolveProfile(effective, picked.name, picked.scope);
	} else {
		selected = resolveProfile(effective, name, scope);
	}
	if (!selected) {
		ctx.ui.notify(`Profile "${name}"${scope ? ` not found in ${scope}` : " not found"}.`, "error");
		return;
	}
	if (
		ctx.hasUI &&
		!(await ctx.ui.confirm(
			"Delete profile",
			`Delete "${selected.ref.name}" [${selected.ref.scope}]? This cannot be undone.`,
		))
	) {
		return;
	}

	const removed = await store.deleteProfile(selected.ref.scope, selected.ref.name);
	if (refsEqual(effective.active, selected.ref)) {
		const next = await store.loadEffective();
		await applyCurrentEffectiveProfile(pi, ctx, next);
	}
	ctx.ui.notify(
		removed
			? `Deleted profile "${selected.ref.name}" [${selected.ref.scope}].`
			: `Profile "${selected.ref.name}" not found in ${selected.ref.scope}.`,
		removed ? "info" : "warning",
	);
}

async function menuRoot(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	store: ProfileStore,
	effective: EffectiveProfiles,
): Promise<void> {
	if (!ctx.hasUI) {
		listProfiles(ctx, effective);
		return;
	}
	const action = await ctx.ui.select("Model Profiles", [
		{ label: "Switch", description: "Activate a project or global profile" },
		{ label: "Create", description: "Build a new profile" },
		{ label: "Generate (AI)", description: "Describe a profile; AI assigns models" },
		{ label: "Edit", description: "Change a role's model" },
		{ label: "Save current", description: "Snapshot current models as a profile" },
		{ label: "Show", description: "Inspect a profile" },
		{ label: "Delete", description: "Remove a profile" },
		{ label: "List", description: "List all profiles" },
	]);
	switch (action) {
		case "Switch":
			return verbSwitch(pi, ctx, store, effective, "switch", undefined, undefined);
		case "Create":
			return verbCreate(pi, ctx, store, effective, undefined, undefined);
		case "Generate (AI)":
			return verbGenerate(pi, ctx, store, effective, undefined, undefined, "");
		case "Edit":
			return verbEdit(pi, ctx, store, effective, undefined, undefined);
		case "Save current":
			return verbSave(pi, ctx, store, effective, undefined, undefined);
		case "Show": {
			const picked = await pickProfile(ctx, effective, {});
			if (!picked || picked === "none") return;
			const selected = resolveProfile(effective, picked.name, picked.scope);
			if (selected) showProfile(pi, ctx, selected);
			return;
		}
		case "Delete":
			return verbDelete(pi, ctx, store, effective, undefined, undefined);
		case "List":
			return listProfiles(ctx, effective);
		default:
			return;
	}
}

const USAGE = [
	"Model Profiles — switch your whole role-set at once.",
	"",
	"  /model-profile                   Open the menu (interactive)",
	"  /model-profile switch <name|none> Activate or clear the project override",
	"  /model-profile use <name|none>    Compatibility alias for switch",
	"  /model-profile show <name>        Inspect a profile",
	"  /model-profile create <name>      Build a profile (pick models)",
	"  /model-profile generate [name] <prompt>  Generate a profile with AI",
	"  /model-profile save <name>        Snapshot current models",
	"  /model-profile edit <name>        Change a role's model",
	"  /model-profile delete <name>      Remove a profile",
	"  /model-profile list               List all profiles",
	"",
	"  Add --scope global (or --global / --project) to target a storage scope.",
].join("\n");

/** Dispatch `/model-profile <args>`. Returns the post-mutation effective view. */
export async function handleProfileCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	store: ProfileStore,
): Promise<EffectiveProfiles> {
	const { verb, name, scope, rest } = parseArgs(args);
	const effective = await store.loadEffective();

	switch (verb) {
		case "":
			await menuRoot(pi, ctx, store, effective);
			break;
		case "switch":
			await verbSwitch(pi, ctx, store, effective, "switch", name, scope);
			break;
		case "use":
			await verbSwitch(pi, ctx, store, effective, "use", name, scope);
			break;
		case "show":
			if (name) {
				const selected = resolveProfile(effective, name, scope);
				if (selected) showProfile(pi, ctx, selected);
				else ctx.ui.notify(`Profile "${name}"${scope ? ` not found in ${scope}` : " not found"}.`, "error");
			} else if (ctx.hasUI) {
				const picked = await pickProfile(ctx, effective, {});
				if (picked && picked !== "none") {
					const selected = resolveProfile(effective, picked.name, picked.scope);
					if (selected) showProfile(pi, ctx, selected);
				}
			} else {
				listProfiles(ctx, effective);
			}
			break;
		case "create":
			await verbCreate(pi, ctx, store, effective, name, scope);
			break;
		case "generate":
		case "gen":
			await verbGenerate(pi, ctx, store, effective, name, scope, rest);
			break;
		case "save":
			await verbSave(pi, ctx, store, effective, name, scope);
			break;
		case "edit":
			await verbEdit(pi, ctx, store, effective, name, scope);
			break;
		case "delete":
		case "remove":
			await verbDelete(pi, ctx, store, effective, name, scope);
			break;
		case "list":
			listProfiles(ctx, effective);
			break;
		default:
			ctx.ui.notify(USAGE, "info");
			break;
	}

	return store.loadEffective();
}
