import assert from "node:assert/strict";
import test from "node:test";
import {
	applyPatch,
	createEmptyState,
	ensurePlaceholderStep,
	extractFileMutation,
	finalizeRun,
	formatRootQuestion,
	recordFileMutation,
	recordToolEnd,
	recordToolStart,
	startNewRun,
} from "../src/state.ts";

test("formatRootQuestion keeps user prompt clean and collapses clipboard image paths", () => {
	const raw =
		"/var/folders/mc/2zht2hx55t93xmm_828byzqr0000gn/T/pi-clipboard-80c9e899-3586-4135-87e3-0e43082fd881.png Look at this error";
	assert.equal(formatRootQuestion(raw, 76, "en"), "[image] Look at this error");
	assert.equal(formatRootQuestion(raw, 76, "zh"), "[图片] Look at this error");
});

test("Layer 0 placeholder upgrades in place on first sidecar patch without overwriting user prompt", () => {
	const state = startNewRun(createEmptyState(), "Fix login 401 error");
	ensurePlaceholderStep(state, 0, [{ toolCallId: "t1", toolName: "read", target: "auth/middleware.ts" }]);
	recordToolStart(state, "t1", "read", { path: "src/auth/middleware.ts" }, 0);
	assert.equal(state.steps.length, 1);
	assert.equal(state.steps[0]!.isPlaceholder, true);
	assert.equal(state.steps[0]!.intent, "Exploring context");

	applyPatch(
		state,
		{
			op: "push",
			phase: "explore",
			intent: "Locate which layer throws 401",
			hypothesis: "Auth middleware may misread token expiry",
		},
		0,
		Date.now(),
		"medium",
	);

	assert.equal(state.goal, "Fix login 401 error");
	assert.equal(state.steps.length, 1);
	assert.equal(state.steps[0]!.isPlaceholder, false);
	assert.equal(state.steps[0]!.intent, "Locate which layer throws 401");
	assert.equal(state.steps[0]!.tools.length, 1);
});

test("pivot marks previous step rejected and transfers current-turn tools to new step", () => {
	const state = startNewRun(createEmptyState(), "Fix login 401 error");
	applyPatch(
		state,
		{
			op: "push",
			phase: "explore",
			intent: "Check token expiry calculation",
			hypothesis: "Clock skew may trigger false expiry",
		},
		0,
	);
	recordToolStart(state, "t1", "read", { path: "src/auth/token.ts" }, 0);
	recordToolEnd(state, "t1", false, 12);

	recordToolStart(state, "t2", "read", { path: "src/auth/redis.ts" }, 1);
	recordToolEnd(state, "t2", false, 8);

	applyPatch(
		state,
		{
			op: "pivot",
			phase: "debug",
			prevVerdict: "Ruled out; token expiry math is correct",
			prevOutcome: "rejected",
			intent: "Check whether session cache write skips TTL refresh",
		},
		1,
	);

	assert.equal(state.steps.length, 2);
	assert.equal(state.steps[0]!.status, "rejected");
	assert.equal(state.steps[0]!.verdict, "Ruled out; token expiry math is correct");
	assert.equal(state.steps[0]!.tools.map((t) => t.toolCallId).join(","), "t1");

	assert.equal(state.steps[1]!.status, "active");
	assert.equal(state.steps[1]!.intent, "Check whether session cache write skips TTL refresh");
	assert.equal(state.steps[1]!.tools.map((t) => t.toolCallId).join(","), "t2");
});

test("high detail patch retains evidence and nextPlan fields", () => {
	const state = startNewRun(createEmptyState(), "Debug Redis TTL eviction");
	applyPatch(
		state,
		{
			op: "push",
			phase: "debug",
			intent: "Check whether RedisSessionStore.save() omits EXPIRE after overwriting session key",
			hypothesis: "SET without EX resets key TTL to persistent or drops previous expiry",
			evidence: "redis.ts:42 calls client.set(key, payload) without passing EX option",
			nextPlan: "Add EX option and run session-store unit tests",
		},
		0,
		Date.now(),
		"high",
	);

	assert.equal(state.steps.length, 1);
	assert.equal(
		state.steps[0]!.evidence,
		"redis.ts:42 calls client.set(key, payload) without passing EX option",
	);
	assert.equal(state.steps[0]!.nextPlan, "Add EX option and run session-store unit tests");
});

test("extractFileMutation and recordFileMutation track where and why files changed", () => {
	const state = startNewRun(createEmptyState(), "Fix TTL refresh");
	applyPatch(state, { op: "push", phase: "edit", intent: "Refresh TTL on session write" }, 2);

	const mut = extractFileMutation("edit", {
		path: "src/auth/redis.ts",
		edits: [
			{
				oldText: "await redis.set(key, val);",
				newText: "await redis.set(key, val);\nawait redis.expire(key, ttl);",
			},
		],
	});
	assert.ok(mut);
	assert.equal(mut.action, "edited");
	assert.equal(mut.addedLines, 2);
	assert.equal(mut.removedLines, 1);

	recordFileMutation(state, mut, 2);
	applyPatch(
		state,
		{
			op: "keep",
			fileChanges: [{ path: "redis.ts", why: "Call expire after set to prevent early eviction" }],
		},
		2,
	);

	assert.equal(state.touchedFiles.length, 1);
	assert.equal(state.touchedFiles[0]!.shortPath, "auth/redis.ts");
	assert.equal(state.touchedFiles[0]!.lastNote, "Call expire after set to prevent early eviction");

	const writeMut = extractFileMutation("write", {
		path: "src/auth/redis.test.ts",
		content: "line1\nline2\nline3",
	});
	assert.ok(writeMut);
	assert.equal(writeMut.action, "written");
	assert.equal(writeMut.addedLines, 3);
	recordFileMutation(state, writeMut, 3);
	assert.equal(state.touchedFiles.length, 2);
});

test("new request archives previous trail and preserves late op=done verdict", () => {
	let state = startNewRun(createEmptyState(), "Does compact reset extension state?");
	applyPatch(state, { op: "push", phase: "explore", intent: "Inspect compaction lifecycle docs" }, 0);
	finalizeRun(state, false);
	assert.equal(state.steps[0]!.status, "done");
	assert.equal(state.steps[0]!.verdict, undefined);

	applyPatch(state, { op: "done", prevVerdict: "Compact keeps extension state and snapshots intact" }, 1);
	assert.equal(state.steps[0]!.verdict, "Compact keeps extension state and snapshots intact");

	state = startNewRun(state, "Add unit tests for compaction");
	assert.equal(state.goal, "Add unit tests for compaction");
	assert.equal(state.steps.length, 0);
	assert.equal(state.history.length, 1);
	assert.equal(state.history[0]!.goal, "Does compact reset extension state?");
	assert.equal(state.history[0]!.steps[0]!.verdict, "Compact keeps extension state and snapshots intact");
});
