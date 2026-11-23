import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { parseIntentPatch, selectAutoSidecarModel } from "../src/sidecar.ts";

function fakeModel(provider: string, id: string, inputCost: number, outputCost: number): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: inputCost, output: outputCost, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	} as Model<Api>;
}

test("parseIntentPatch handles fenced JSON, extra prose, warning reset, evidence, nextPlan, and fileChanges", () => {
	const raw = [
		"Here is the patch:",
		"```json",
		JSON.stringify({
			op: "resolve_and_push",
			phase: "edit",
			prevVerdict: "Confirmed RedisSessionStore.save() omits EXPIRE",
			prevOutcome: "done",
			intent: "Add EX option to RedisSessionStore.save()",
			hypothesis: "Setting EX atomically prevents stale session eviction",
			evidence: "redis.ts:42 calls client.set without TTL arguments",
			nextPlan: "Run auth unit tests to verify session renewal",
			fileChanges: [{ path: "src/auth/redis.ts", why: "Pass EX option when persisting session key" }],
			warning: null,
		}),
		"```",
	].join("\n");

	const patch = parseIntentPatch(raw, "high");
	assert.ok(patch);
	assert.equal(patch.op, "resolve_and_push");
	assert.equal(patch.phase, "edit");
	assert.equal(patch.warning, null);
	assert.equal(patch.evidence, "redis.ts:42 calls client.set without TTL arguments");
	assert.equal(patch.nextPlan, "Run auth unit tests to verify session renewal");
	assert.equal(patch.fileChanges?.length, 1);
	assert.equal(patch.fileChanges?.[0]?.why, "Pass EX option when persisting session key");

	assert.equal(parseIntentPatch("not json at all"), null);
});

test("selectAutoSidecarModel prefers fast cheap models over flagship models", () => {
	const flagship = fakeModel("anthropic", "claude-opus-4-6", 15, 75);
	const haiku = fakeModel("anthropic", "claude-haiku-4-5", 0.8, 4);
	const mini = fakeModel("openai", "gpt-4.1-mini", 0.4, 1.6);

	assert.equal(selectAutoSidecarModel([flagship, haiku, mini])?.id, "gpt-4.1-mini");
	assert.equal(selectAutoSidecarModel([flagship, haiku])?.id, "claude-haiku-4-5");
});

test("selectAutoSidecarModel falls back to lowest-cost model when no preferred pattern matches", () => {
	const expensive = fakeModel("custom", "mega-model-v2", 20, 60);
	const cheap = fakeModel("custom", "tiny-model-v1", 0.1, 0.3);

	assert.equal(selectAutoSidecarModel([expensive, cheap])?.id, "tiny-model-v1");
});
