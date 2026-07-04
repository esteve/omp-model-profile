/**
 * Shared types for the model-profiles extension.
 *
 * A *profile* is a named preset that assigns a model to each built-in role
 * (Architect/`plan`, Default, Subtask/`task`, …) plus optional cycle order and
 * per-subagent overrides. Switching profiles re-points every role consumer at
 * once via runtime settings overrides.
 */

/** Where a profile is stored. Project files win by bare-name lookup. */
export type ProfileScope = "global" | "project";

/** A named profile reference anchored to one storage scope. */
export interface ProfileRef {
	name: string;
	scope: ProfileScope;
}

/** A single named profile. */
export interface ModelProfile {
	/** Free-text description shown in pickers and `show`. */
	description?: string;
	/**
	 * Role id → model pattern. Keys are role ids (`default`, `plan`, `task`, …);
	 * values are model patterns understood by the host resolver
	 * (e.g. `anthropic/claude-sonnet-4-5:high` or `pi/slow`).
	 */
	modelRoles: Record<string, string>;
	/** Optional Ctrl+P cycle order (role ids / model patterns). */
	cycleOrder?: string[];
	/** Optional per-subagent model overrides (`task.agentModelOverrides`). */
	taskAgentModelOverrides?: Record<string, string>;
}

/** One scope's named profile entry, preserved even when another scope shadows it. */
export interface ScopedProfile extends ProfileRef {
	profile: ModelProfile;
}

/** On-disk shape of a single scope's profile file. */
export interface ProfileFile {
	/** Exact active profile ref for this scope, if any. */
	active?: ProfileRef;
	/** Named profiles keyed by profile name. */
	profiles: Record<string, ModelProfile>;
}

/** Merged view across global + project scopes. */
export interface EffectiveProfiles {
	/** Bare-name lookup where project profiles override global profiles. */
	profiles: Record<string, ModelProfile>;
	/** Global profiles by name. */
	globalProfiles: Record<string, ModelProfile>;
	/** Project profiles by name. */
	projectProfiles: Record<string, ModelProfile>;
	/** All profiles, one entry per scope/name pair. */
	entries: ScopedProfile[];
	/** Exact active profile ref (project wins; falls back to global). */
	active: ProfileRef | undefined;
	/** Resolved active profile payload, when the active ref still exists. */
	activeProfile: ModelProfile | undefined;
}
