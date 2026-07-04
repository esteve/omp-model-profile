import { describe, expect, test } from "bun:test";
import { mergeProfiles, parseProfileFile } from "../src/store";

describe("profile store parsing", () => {
	test("coerces malformed profile files instead of throwing", () => {
		const parsed = parseProfileFile(
			{
				active: 42,
				profiles: {
					valid: {
						description: "  useful  ",
						modelRoles: {
							default: " anthropic/sonnet:high ",
							empty: "   ",
						},
						cycleOrder: [" smol ", 1, "default"],
						taskAgentModelOverrides: {
							reviewer: " pi/slow ",
							empty: "",
						},
					},
					dropped: null,
				},
			},
			"global",
		);

		expect(parsed).toEqual({
			profiles: {
				valid: {
					description: "useful",
					modelRoles: { default: "anthropic/sonnet:high" },
					cycleOrder: ["smol", "default"],
					taskAgentModelOverrides: { reviewer: "pi/slow" },
				},
			},
		});
	});

	test("normalises legacy string actives into scoped refs", () => {
		const parsed = parseProfileFile(
			{
				active: "deep-review",
				profiles: { "deep-review": { modelRoles: { default: "anthropic/sonnet" } } },
			},
			"global",
		);

		expect(parsed.active).toEqual({ name: "deep-review", scope: "global" });
	});
});

describe("profile store merging", () => {
	test("project profiles override global profiles by name but keep both scope maps", () => {
		const effective = mergeProfiles(
			{
				active: { name: "shared", scope: "global" },
				profiles: {
					shared: { modelRoles: { default: "global/default" } },
					globalOnly: { modelRoles: { default: "global/only" } },
				},
			},
			{
				active: { name: "shared", scope: "project" },
				profiles: {
					shared: { modelRoles: { default: "project/default" } },
					projectOnly: { modelRoles: { default: "project/only" } },
				},
			},
		);

		expect(effective.active).toEqual({ name: "shared", scope: "project" });
		expect(effective.activeProfile?.modelRoles.default).toBe("project/default");
		expect(effective.profiles.shared.modelRoles.default).toBe("project/default");
		expect(effective.globalProfiles.shared.modelRoles.default).toBe("global/default");
		expect(effective.projectProfiles.shared.modelRoles.default).toBe("project/default");
	});

	test("a project active ref can target a global profile", () => {
		const effective = mergeProfiles(
			{
				profiles: {
					shared: { modelRoles: { default: "global/default" } },
				},
			},
			{
				active: { name: "shared", scope: "global" },
				profiles: {
					shared: { modelRoles: { default: "project/default" } },
				},
			},
		);

		expect(effective.active).toEqual({ name: "shared", scope: "global" });
		expect(effective.activeProfile?.modelRoles.default).toBe("global/default");
		expect(effective.profiles.shared.modelRoles.default).toBe("project/default");
	});

	test("drops active pointer when it does not resolve in the referenced scope", () => {
		const effective = mergeProfiles(
			{ active: { name: "missing", scope: "global" }, profiles: { userOnly: { modelRoles: {} } } },
			{ profiles: {} },
		);

		expect(effective.active).toBeUndefined();
		expect(effective.activeProfile).toBeUndefined();
	});
});
