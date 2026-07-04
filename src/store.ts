/**
 * Profile persistence: tolerant JSON parsing, global/project merge, and
 * scope-aware read-modify-write. Zero runtime deps beyond Bun + Node stdlib.
 *
 * Pure helpers (`parseProfileFile`, `mergeProfiles`) are exported separately so
 * the merge precedence and tolerant-parse contracts can be unit-tested without
 * touching the filesystem.
 */
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import type { EffectiveProfiles, ModelProfile, ProfileFile, ProfileRef, ProfileScope, ScopedProfile } from "./types";

/** Filename used in both scopes. */
export const STORE_FILENAME = "model-profiles.json";

function normalizeScope(value: unknown): ProfileScope | undefined {
	return value === "global" || value === "user" ? "global" : value === "project" ? "project" : undefined;
}

function parseStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
	}
	return out;
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string" && entry.trim()) out[key] = entry.trim();
	}
	return Object.keys(out).length ? out : undefined;
}

function parseProfileRef(value: unknown, defaultScope: ProfileScope): ProfileRef | undefined {
	if (typeof value === "string" && value.trim()) return { name: value.trim(), scope: defaultScope };
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const obj = value as Record<string, unknown>;
	const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : undefined;
	const scope = normalizeScope(obj.scope);
	return name && scope ? { name, scope } : undefined;
}

/** Coerce an arbitrary value into a {@link ModelProfile}, or drop it. */
function parseProfile(value: unknown): ModelProfile | undefined {
	if (!value || typeof value !== "object") return undefined;
	const obj = value as Record<string, unknown>;

	const modelRoles: Record<string, string> = {};
	if (obj.modelRoles && typeof obj.modelRoles === "object" && !Array.isArray(obj.modelRoles)) {
		for (const [role, model] of Object.entries(obj.modelRoles as Record<string, unknown>)) {
			if (typeof model === "string" && model.trim()) modelRoles[role] = model.trim();
		}
	}

	const profile: ModelProfile = { modelRoles };
	if (typeof obj.description === "string" && obj.description.trim()) profile.description = obj.description.trim();

	const cycleOrder = parseStringArray(obj.cycleOrder);
	if (cycleOrder.length) profile.cycleOrder = cycleOrder;

	const overrides = parseStringRecord(obj.taskAgentModelOverrides);
	if (overrides) profile.taskAgentModelOverrides = overrides;

	return profile;
}

/**
 * Parse raw file contents into a valid {@link ProfileFile}, tolerating missing
 * fields, wrong types, and malformed entries (each is dropped, never thrown).
 */
export function parseProfileFile(raw: unknown, defaultScope: ProfileScope): ProfileFile {
	if (!raw || typeof raw !== "object") return { profiles: {} };
	const obj = raw as Record<string, unknown>;

	const profiles: Record<string, ModelProfile> = {};
	if (obj.profiles && typeof obj.profiles === "object" && !Array.isArray(obj.profiles)) {
		for (const [name, value] of Object.entries(obj.profiles as Record<string, unknown>)) {
			const profile = parseProfile(value);
			if (profile) profiles[name] = profile;
		}
	}

	const active = parseProfileRef(obj.active, defaultScope);
	return active ? { active, profiles } : { profiles };
}

function buildEntries(scope: ProfileScope, profiles: Record<string, ModelProfile>): ScopedProfile[] {
	return Object.entries(profiles).map(([name, profile]) => ({ name, scope, profile }));
}

function resolveProfileRef(
	globalProfiles: Record<string, ModelProfile>,
	projectProfiles: Record<string, ModelProfile>,
	ref: ProfileRef | undefined,
): ModelProfile | undefined {
	if (!ref) return undefined;
	return ref.scope === "global" ? globalProfiles[ref.name] : projectProfiles[ref.name];
}

function refsEqual(a: ProfileRef | undefined, b: ProfileRef | undefined): boolean {
	return a?.name === b?.name && a?.scope === b?.scope;
}

/**
 * Merge global and project scopes. Project profiles override global profiles by
 * bare name, while the active ref remains scope-aware so a project can
 * explicitly activate a global profile.
 */
export function mergeProfiles(global: ProfileFile, project: ProfileFile): EffectiveProfiles {
	const profiles: Record<string, ModelProfile> = { ...global.profiles, ...project.profiles };
	const active = project.active ?? global.active;
	const activeProfile = resolveProfileRef(global.profiles, project.profiles, active);

	return {
		profiles,
		globalProfiles: { ...global.profiles },
		projectProfiles: { ...project.profiles },
		entries: [...buildEntries("project", project.profiles), ...buildEntries("global", global.profiles)],
		active: activeProfile ? active : undefined,
		activeProfile,
	};
}

/** Scope-aware profile storage backed by two JSON files. */
export class ProfileStore {
	readonly #globalPath: string;
	readonly #projectPath: string;

	constructor(globalPath: string, projectPath: string) {
		this.#globalPath = globalPath;
		this.#projectPath = projectPath;
	}

	pathFor(scope: ProfileScope): string {
		return scope === "global" ? this.#globalPath : this.#projectPath;
	}

	/** Read one scope's file. Missing → empty; malformed JSON → thrown. */
	async readScope(scope: ProfileScope): Promise<ProfileFile> {
		const filePath = this.pathFor(scope);
		try {
			const raw = await Bun.file(filePath).json();
			return parseProfileFile(raw, scope);
		} catch (err) {
			if (err instanceof Error && (err as { code?: string }).code === "ENOENT") return { profiles: {} };
			throw new Error(
				`model-profiles: cannot parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async writeScope(scope: ProfileScope, file: ProfileFile): Promise<void> {
		const filePath = this.pathFor(scope);
		await mkdir(path.dirname(filePath), { recursive: true });
		await Bun.write(filePath, `${JSON.stringify(file, null, 2)}\n`);
	}

	/** Merged global + project view. */
	async loadEffective(): Promise<EffectiveProfiles> {
		const [global, project] = await Promise.all([this.readScope("global"), this.readScope("project")]);
		return mergeProfiles(global, project);
	}

	/** Set (or clear) the active pointer in a scope. */
	async setActive(scope: ProfileScope, active: ProfileRef | undefined): Promise<void> {
		const file = await this.readScope(scope);
		if (active) file.active = active;
		else delete file.active;
		await this.writeScope(scope, file);
	}

	/** Create or overwrite a named profile in a scope. */
	async saveProfile(scope: ProfileScope, name: string, profile: ModelProfile): Promise<void> {
		const file = await this.readScope(scope);
		file.profiles[name] = profile;
		await this.writeScope(scope, file);
	}

	/**
	 * Remove a named profile from a scope. Also clears any active pointer that
	 * referenced the removed profile. Returns whether anything was removed.
	 */
	async deleteProfile(scope: ProfileScope, name: string): Promise<boolean> {
		const file = await this.readScope(scope);
		if (!(name in file.profiles)) return false;
		delete file.profiles[name];
		if (refsEqual(file.active, { name, scope })) delete file.active;
		await this.writeScope(scope, file);

		if (scope === "global") {
			const project = await this.readScope("project");
			if (refsEqual(project.active, { name, scope: "global" })) {
				delete project.active;
				await this.writeScope("project", project);
			}
		}

		return true;
	}
}
