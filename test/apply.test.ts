import { describe, expect, test } from "bun:test";
import {
	mapProfileToOverrides,
	resolveCompatibleModelString,
	resolveModelString,
	splitThinkingSuffix,
	stripThinkingSuffix,
} from "../src/apply";
import { testModel } from "./fixtures";

const sonnet = testModel("anthropic", "claude-sonnet-4-5");
const opus = testModel("anthropic", "claude-opus-4-5");
const codex = testModel("openai-codex", "gpt-5-codex");
const llama = testModel("ollama", "llama3:8b");

describe("stripThinkingSuffix", () => {
	test("strips known thinking selectors but preserves model ids containing colons", () => {
		expect(stripThinkingSuffix("anthropic/claude-sonnet-4-5:high")).toBe("anthropic/claude-sonnet-4-5");
		expect(stripThinkingSuffix("ollama/llama3:8b")).toBe("ollama/llama3:8b");
	});

	test("strips the auto selector", () => {
		expect(stripThinkingSuffix("anthropic/claude-opus-4-5:auto")).toBe("anthropic/claude-opus-4-5");
	});
});

describe("splitThinkingSuffix", () => {
	test("returns the recognised suffix, including auto and off", () => {
		expect(splitThinkingSuffix("anthropic/claude-opus-4-5:auto")).toEqual({
			base: "anthropic/claude-opus-4-5",
			suffix: "auto",
		});
		expect(splitThinkingSuffix("anthropic/claude-opus-4-5:off")).toEqual({
			base: "anthropic/claude-opus-4-5",
			suffix: "off",
		});
	});

	test("leaves colon-bearing ids without a thinking suffix intact", () => {
		expect(splitThinkingSuffix("ollama/llama3:8b")).toEqual({ base: "ollama/llama3:8b", suffix: undefined });
		expect(splitThinkingSuffix("anthropic/claude-opus-4-5")).toEqual({
			base: "anthropic/claude-opus-4-5",
			suffix: undefined,
		});
	});
});

describe("resolveModelString", () => {
	test("matches exact provider/id after stripping thinking", () => {
		expect(resolveModelString("anthropic/claude-sonnet-4-5:high", [sonnet, opus])).toBe(sonnet);
	});

	test("falls back from provider/id to canonical id", () => {
		const resolved = resolveModelString("custom/claude-opus-4-5:medium", [sonnet], id =>
			id === "claude-opus-4-5" ? opus : undefined,
		);

		expect(resolved).toBe(opus);
	});

	test("resolves bare ids through canonical resolver", () => {
		expect(resolveModelString("gpt-5-codex", [codex], id => (id === "gpt-5-codex" ? codex : undefined))).toBe(codex);
	});

	test("keeps colon-bearing ids when suffix is not a thinking level", () => {
		expect(resolveModelString("ollama/llama3:8b", [llama])).toBe(llama);
	});

	test("returns undefined for unknown models", () => {
		expect(resolveModelString("unknown/model", [sonnet])).toBeUndefined();
	});
});

describe("resolveCompatibleModelString", () => {
	test("falls back to an available id match when the host lacks canonical resolution", () => {
		expect(resolveCompatibleModelString("claude-opus-4-5", [sonnet, opus])).toBe(opus);
		expect(resolveCompatibleModelString("custom/claude-opus-4-5:medium", [sonnet, opus])).toBe(opus);
	});

	test("prefers the canonical resolver when the available list has no id match", () => {
		expect(
			resolveCompatibleModelString("gpt-5-codex", [sonnet], id => (id === "gpt-5-codex" ? codex : undefined)),
		).toBe(codex);
	});
});

describe("mapProfileToOverrides", () => {
	test("trims model roles and drops empty optional overrides", () => {
		expect(
			mapProfileToOverrides({
				modelRoles: { default: " anthropic/claude-sonnet-4-5 ", smol: "" },
				cycleOrder: [],
				taskAgentModelOverrides: {},
			}),
		).toEqual({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
			cycleOrder: undefined,
			taskAgentModelOverrides: undefined,
		});
	});

	test("strips the auto suffix from installed overrides but keeps concrete levels", () => {
		expect(
			mapProfileToOverrides({
				modelRoles: {
					default: "anthropic/claude-opus-4-5:auto",
					slow: "anthropic/claude-opus-4-5:high",
					plan: "anthropic/claude-opus-4-5:off",
				},
			}).modelRoles,
		).toEqual({
			default: "anthropic/claude-opus-4-5",
			slow: "anthropic/claude-opus-4-5:high",
			plan: "anthropic/claude-opus-4-5:off",
		});
	});
});
