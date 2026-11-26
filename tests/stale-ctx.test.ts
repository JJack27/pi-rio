import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piRioExtension from "../src/index.ts";

const STALE = "This extension ctx is stale after session replacement or reload.";

function fakeModel(): Model<Api> {
	return {
		provider: "openai",
		id: "gpt-4.1-mini",
		name: "gpt-4.1-mini",
		api: "openai-responses",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.4, output: 1.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	} as Model<Api>;
}

/**
 * Mimics Pi's real ExtensionRunner ctx: every getter calls assertActive(),
 * which throws once the runner is invalidated (print-mode exit, reload, session replace).
 */
function createStalableCtx(streamSimple: () => unknown) {
	let stale = false;
	const model = fakeModel();
	const guard = <T>(value: T): T => {
		if (stale) throw new Error(STALE);
		return value;
	};
	const ctx = {
		get cwd() {
			return guard(process.cwd());
		},
		get mode() {
			return guard("print");
		},
		get hasUI() {
			return guard(false);
		},
		get model() {
			return guard(model);
		},
		get ui() {
			return guard({ notify: () => {}, setWidget: () => {} });
		},
		get sessionManager() {
			return guard({ getSessionId: () => "stale-ctx-test", getBranch: () => [] });
		},
		get modelRegistry() {
			return guard({
				getAvailable: () => [model],
				find: () => model,
				hasConfiguredAuth: () => true,
				streamSimple,
			});
		},
	} as unknown as ExtensionContext;
	return { ctx, invalidate: () => (stale = true) };
}

function loadExtension() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const mockPi = {
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, fn),
		registerShortcut: () => {},
		registerCommand: () => {},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	piRioExtension(mockPi);
	return handlers;
}

test("sidecar finishing after the ctx goes stale (print mode exit) does not crash", async () => {
	let releaseSidecar!: () => void;
	const sidecarGate = new Promise<void>((resolve) => (releaseSidecar = resolve));
	const streamSimple = () => ({
		result: async () => {
			await sidecarGate;
			return {
				stopReason: "stop",
				content: [{ type: "text", text: '{"op":"push","phase":"explore","intent":"Check echo output"}' }],
				usage: { input: 10, output: 5, cost: { total: 0 } },
			};
		},
	});

	const { ctx, invalidate } = createStalableCtx(streamSimple);
	const handlers = loadExtension();

	const unhandled: unknown[] = [];
	const onUnhandled = (err: unknown) => unhandled.push(err);
	process.on("unhandledRejection", onUnhandled);

	try {
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")!({ type: "before_agent_start", messageType: "user", prompt: "echo hi" }, ctx);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0 }, ctx);
		await handlers.get("message_end")!(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo hi" } }],
				},
			},
			ctx,
		);

		// Pi finishes the -p run and invalidates ctx while the sidecar request is still in flight.
		invalidate();
		releaseSidecar();

		// Let the background drain loop resume and settle.
		for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

		assert.deepEqual(unhandled, [], `Expected no unhandled rejection, got: ${String(unhandled[0])}`);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("session_shutdown stops in-flight sidecar work from touching the stale ctx", async () => {
	let releaseSidecar!: () => void;
	const sidecarGate = new Promise<void>((resolve) => (releaseSidecar = resolve));
	const streamSimple = () => ({
		result: async () => {
			await sidecarGate;
			return {
				stopReason: "stop",
				content: [{ type: "text", text: '{"op":"push","phase":"explore","intent":"Check echo output"}' }],
				usage: { input: 10, output: 5, cost: { total: 0 } },
			};
		},
	});

	const { ctx, invalidate } = createStalableCtx(streamSimple);
	const handlers = loadExtension();

	const unhandled: unknown[] = [];
	const onUnhandled = (err: unknown) => unhandled.push(err);
	process.on("unhandledRejection", onUnhandled);

	try {
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")!({ type: "before_agent_start", messageType: "user", prompt: "echo hi" }, ctx);
		await handlers.get("message_end")!(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo hi" } }],
				},
			},
			ctx,
		);

		await handlers.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
		invalidate();
		releaseSidecar();

		for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

		assert.deepEqual(unhandled, [], `Expected no unhandled rejection, got: ${String(unhandled[0])}`);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
