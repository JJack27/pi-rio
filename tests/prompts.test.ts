import assert from "node:assert/strict";
import test from "node:test";
import {
	DETAIL_PROFILES,
	buildSidecarUserPrompt,
	getSidecarSystemPrompt,
	normalizeDetailLevel,
	resolveOutputLanguage,
	truncateHeadTail,
} from "../src/prompts.ts";
import { applyPatch, createEmptyState, startNewRun } from "../src/state.ts";

test("low, medium, and high detail levels produce distinct dedicated system prompts", () => {
	const low = getSidecarSystemPrompt("low", "en");
	const medium = getSidecarSystemPrompt("medium", "en");
	const high = getSidecarSystemPrompt("high", "en");

	assert.notEqual(low, medium);
	assert.notEqual(medium, high);
	assert.notEqual(low, high);

	assert.ok(low.includes("LOW detail mode"));
	assert.ok(low.includes("Omit hypothesis, evidence, and nextPlan"));

	assert.ok(medium.includes("MEDIUM detail mode"));
	assert.ok(medium.includes("Include hypothesis"));

	assert.ok(high.includes("HIGH detail mode"));
	assert.ok(high.includes("evidence"));
	assert.ok(high.includes("nextPlan"));
});

test("system prompts inject output language directives for English, Chinese, and custom languages", () => {
	const en = getSidecarSystemPrompt("medium", "en");
	const zh = getSidecarSystemPrompt("medium", "zh");
	const ja = getSidecarSystemPrompt("high", "ja");

	assert.ok(en.includes("English"));
	assert.ok(zh.includes("Simplified Chinese"));
	assert.ok(ja.includes("Japanese"));
});

test("resolveOutputLanguage handles explicit codes and auto locale detection", () => {
	assert.equal(resolveOutputLanguage("en", {}), "en");
	assert.equal(resolveOutputLanguage("zh-CN", {}), "zh");
	assert.equal(resolveOutputLanguage("ja", {}), "ja");
	assert.equal(resolveOutputLanguage("auto", { LC_ALL: "zh_CN.UTF-8" }), "zh");
	assert.equal(resolveOutputLanguage("auto", { LC_ALL: "C", LANG: "zh_TW.UTF-8" }), "zh-tw");
	assert.equal(resolveOutputLanguage("auto", { LANG: "en_US.UTF-8" }), "en");
	assert.equal(resolveOutputLanguage("auto", {}), "en");
});

test("normalizeDetailLevel handles canonical values and shorthand aliases", () => {
	assert.equal(normalizeDetailLevel("low"), "low");
	assert.equal(normalizeDetailLevel("minimal"), "low");
	assert.equal(normalizeDetailLevel("medium"), "medium");
	assert.equal(normalizeDetailLevel("med"), "medium");
	assert.equal(normalizeDetailLevel("high"), "high");
	assert.equal(normalizeDetailLevel("verbose"), "high");
	assert.equal(normalizeDetailLevel("unknown", "medium"), "medium");
});

test("truncateHeadTail keeps opening and closing context while bounding length", () => {
	const longThinking = `${"A".repeat(800)}${"B".repeat(800)}${"C".repeat(800)}`;
	const cut = truncateHeadTail(longThinking, 100, 100);
	assert.ok(cut.startsWith("A".repeat(100)));
	assert.ok(cut.endsWith("C".repeat(100)));
	assert.ok(cut.includes("omitted"));
});

test("buildSidecarUserPrompt scales thinking budget and evidence context by detail level", () => {
	const state = startNewRun(createEmptyState(), "Fix auth 401");
	applyPatch(
		state,
		{
			op: "push",
			phase: "debug",
			intent: "Inspect middleware",
			evidence: "tokenStore.ts:44 returns expired=true 12s early",
		},
		0,
		Date.now(),
		"high",
	);

	const longThinking = `${"X".repeat(1200)}MIDDLE_MARKER${"Y".repeat(1200)}`;
	const delta = {
		turnIndex: 1,
		thinking: longThinking,
		assistantText: "",
		toolCalls: [{ toolCallId: "1", toolName: "read", target: "auth/index.ts" }],
		previousOutcomes: [{ toolName: "bash", target: "vitest", isError: true, snippet: "Expected 200 got 401" }],
	};

	const lowPrompt = buildSidecarUserPrompt(state, delta, "low");
	const highPrompt = buildSidecarUserPrompt(state, delta, "high");

	assert.ok(lowPrompt.includes("Current user request (Root): Fix auth 401"));
	assert.ok(lowPrompt.includes("omitted"));
	assert.ok(!lowPrompt.includes("tokenStore.ts:44 returns expired=true"));

	// High detail keeps the full 2400+ char thinking block without omitting MIDDLE_MARKER and includes prior evidence
	assert.ok(highPrompt.includes("MIDDLE_MARKER"));
	assert.ok(highPrompt.includes("evidence: tokenStore.ts:44 returns expired=true 12s early"));
	assert.ok(DETAIL_PROFILES.high.maxTokens > DETAIL_PROFILES.medium.maxTokens);
	assert.ok(DETAIL_PROFILES.medium.maxTokens > DETAIL_PROFILES.low.maxTokens);
});
