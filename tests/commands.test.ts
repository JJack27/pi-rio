import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piRioExtension, { loadConfig, saveConfig } from "../src/index.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.4, output: 1.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	} as Model<Api>;
}

test("loadConfig and saveConfig round-trip all RioConfig fields cleanly", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-rio-cfg-"));
	try {
		const path = join(dir, "rio.json");
		assert.deepEqual(loadConfig(path), DEFAULT_CONFIG);

		saveConfig(
			{
				enabled: false,
				provider: "openai",
				modelId: "gpt-4.1-mini",
				language: "zh",
				detail: "high",
				showWidgetWhenIdle: false,
			},
			path,
		);

		assert.deepEqual(loadConfig(path), {
			enabled: false,
			provider: "openai",
			modelId: "gpt-4.1-mini",
			language: "zh",
			detail: "high",
			showWidgetWhenIdle: false,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("/rio command registers autocomplete and handles model, lang, detail, and status", async () => {
	let registeredCommand:
		| {
				handler: (args: string, ctx: ExtensionContext) => Promise<void>;
				getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
		  }
		| undefined;

	const mockPi = {
		on: () => {},
		registerShortcut: () => {},
		registerCommand: (name: string, def: typeof registeredCommand) => {
			if (name === "rio") registeredCommand = def;
		},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;

	piRioExtension(mockPi);
	assert.ok(registeredCommand, "Expected /rio command to be registered");

	const notifications: { msg: string; level: string }[] = [];
	const models = [fakeModel("openai", "gpt-4.1-mini"), fakeModel("anthropic", "claude-haiku-4-5")];
	const mockCtx = {
		cwd: process.cwd(),
		hasUI: false,
		mode: "print",
		model: models[0],
		modelRegistry: {
			getAvailable: () => models,
			find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
			hasConfiguredAuth: () => true,
		},
		sessionManager: {
			getSessionId: () => "test-session",
			getBranch: () => [],
		},
		ui: {
			notify: (msg: string, level: string) => notifications.push({ msg, level }),
			setWidget: () => {},
		},
	} as unknown as ExtensionContext;

	// Autocomplete checks
	const subCompletions = registeredCommand.getArgumentCompletions?.("") ?? [];
	const subValues = subCompletions.map((c) => c.value);
	assert.ok(subValues.includes("model"));
	assert.ok(subValues.includes("lang"));
	assert.ok(subValues.includes("detail"));

	const detailCompletions = registeredCommand.getArgumentCompletions?.("detail ") ?? [];
	assert.deepEqual(
		detailCompletions.map((c) => c.label),
		["low", "medium", "high"],
	);

	// Inspect status without mutating user's real ~/.pi/agent/rio.json
	await registeredCommand.handler("status", mockCtx);
	assert.equal(notifications.length, 1);
	assert.ok(notifications[0]!.msg.includes("Language:"));
	assert.ok(notifications[0]!.msg.includes("Detail:"));

	// Invalid detail level rejects with warning
	await registeredCommand.handler("detail ultra", mockCtx);
	assert.equal(notifications[1]!.level, "warning");
	assert.ok(notifications[1]!.msg.includes("Invalid detail level"));
});
