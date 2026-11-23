import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { applyPatch, createEmptyState, recordFileMutation, startNewRun } from "../src/state.ts";
import { renderWidgetLines, wrapPlainText } from "../src/ui.ts";

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("renderWidgetLines adapts density across low, medium, and high detail levels", () => {
	const state = startNewRun(createEmptyState(), "Fix OAuth refresh race");
	applyPatch(state, { op: "push", phase: "explore", intent: "Trace token refresh path" }, 0, Date.now(), "high");
	applyPatch(
		state,
		{
			op: "pivot",
			phase: "debug",
			prevVerdict: "Mutex works fine; failure is clock skew",
			intent: "Inspect expiry window check in TokenStore.isExpired()",
		},
		1,
		Date.now(),
		"high",
	);
	applyPatch(
		state,
		{
			op: "resolve_and_push",
			phase: "edit",
			prevVerdict: "Confirmed no skew buffer before upstream call",
			intent: "Add 60s skew buffer in TokenStore.isExpired()",
			hypothesis: "Tokens with <60s TTL expire mid-flight",
			evidence: "refresh.test.ts returned 401 when TTL was 12s",
			nextPlan: "Re-run refresh.test.ts to verify fix",
		},
		2,
		Date.now(),
		"high",
	);
	recordFileMutation(state, { path: "src/auth/tokenStore.ts", action: "edited", addedLines: 12, removedLines: 3 }, 2);
	recordFileMutation(state, { path: "tests/auth/refresh.test.ts", action: "written", addedLines: 34, removedLines: 0 }, 2);
	applyPatch(
		state,
		{
			op: "keep",
			fileChanges: [
				{ path: "tokenStore.ts", why: "Add 60s skew window" },
				{ path: "refresh.test.ts", why: "Cover near-expiry retry race" },
			],
		},
		2,
		Date.now(),
		"high",
	);

	const lowLines = renderWidgetLines(state, mockTheme, 120, 0, { detail: "low", resolvedLang: "en" });
	const medLines = renderWidgetLines(state, mockTheme, 120, 0, { detail: "medium", resolvedLang: "en" });
	const highLines = renderWidgetLines(state, mockTheme, 120, 0, { detail: "high", resolvedLang: "en" });

	// Low: header + active step + compact edited file count (no previous steps, no hypothesis/evidence)
	assert.equal(lowLines.length, 3);
	assert.ok(!lowLines.join("\n").includes("Hyp:"));
	assert.ok(!lowLines.join("\n").includes("Evid:"));

	// Medium: header + 1 previous step + active step with inline Hyp + 1 edited file line
	assert.equal(medLines.length, 4);
	assert.ok(medLines.join("\n").includes("Hyp:"));
	assert.ok(!medLines.join("\n").includes("Evid:"));

	// High: header + 2 previous steps + active step + Hyp + Evid + Next + 2 edited file lines
	assert.equal(highLines.length, 9);
	assert.ok(highLines.join("\n").includes("Hyp:"));
	assert.ok(highLines.join("\n").includes("Evid:"));
	assert.ok(highLines.join("\n").includes("Next:"));
	assert.ok(highLines.join("\n").includes("Add 60s skew window"));
	assert.ok(highLines.join("\n").includes("Cover near-expiry retry race"));
});

test("renderWidgetLines localizes UI labels when resolvedLang is zh", () => {
	const state = startNewRun(createEmptyState(), "修复登录问题", Date.now(), "zh");
	applyPatch(
		state,
		{
			op: "push",
			phase: "debug",
			intent: "核对 token 过期判断逻辑",
			hypothesis: "怀疑缺少时钟偏移缓冲",
			evidence: "日志显示剩余 12 秒时触发 401",
		},
		0,
		Date.now(),
		"high",
		"zh",
	);

	const zhLines = renderWidgetLines(state, mockTheme, 120, 0, { detail: "high", resolvedLang: "zh" });
	const joined = zhLines.join("\n");
	assert.ok(joined.includes("[排错]"));
	assert.ok(joined.includes("假设:"));
	assert.ok(joined.includes("依据:"));
});

test("wrapPlainText splits long text cleanly within column limit", () => {
	const wrapped = wrapPlainText(
		"TokenStore.isExpired() checks strict equality without any clock skew buffer before sending upstream requests",
		40,
	);
	assert.ok(wrapped.length >= 3);
	for (const line of wrapped) {
		assert.ok(line.length <= 40, `Expected line <= 40 chars, got: "${line}" (${line.length})`);
	}
});
