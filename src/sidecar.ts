import { type Api, type Model, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DETAIL_PROFILES,
	buildSidecarUserPrompt,
	getSidecarSystemPrompt,
	resolveOutputLanguage,
} from "./prompts.ts";
import { cleanText, normalizePhase } from "./state.ts";
import type { DetailLevel, IntentPatch, IntentState, PatchOp, RioConfig, TurnDelta } from "./types.ts";

const VALID_OPS: ReadonlySet<PatchOp> = new Set([
	"keep",
	"push",
	"resolve_and_push",
	"pivot",
	"done",
]);

/** Ordered preference patterns for automatic cheap/fast sidecar model selection. */
const AUTO_CHEAP_MODEL_PREFERENCES = [
	"gpt-4.1-mini",
	"gpt-4.1-nano",
	"gpt-4o-mini",
	"gpt-5-mini",
	"gpt-5-nano",
	"claude-haiku-4-5",
	"claude-3-5-haiku",
	"claude-haiku",
	"gemini-2.5-flash-lite",
	"gemini-2.5-flash",
	"gemini-2.0-flash",
	"deepseek-chat",
	"qwen-turbo",
	"flash",
	"mini",
	"haiku",
	"nano",
];

export function parseIntentPatch(rawText: string, detail: DetailLevel = "medium"): IntentPatch | null {
	if (!rawText || !rawText.trim()) return null;
	let text = rawText.trim();

	// Strip optional ```json ... ``` fences
	const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fenceMatch && fenceMatch[1]) {
		text = fenceMatch[1].trim();
	}

	// Extract outermost JSON object if surrounded by extra text
	const firstBrace = text.indexOf("{");
	const lastBrace = text.lastIndexOf("}");
	if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
		return null;
	}
	const jsonSlice = text.slice(firstBrace, lastBrace + 1);

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonSlice);
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}

	const limits = DETAIL_PROFILES[detail].limits;
	const obj = parsed as Record<string, unknown>;
	const rawOp = typeof obj.op === "string" ? obj.op.trim() : "";
	const op: PatchOp = VALID_OPS.has(rawOp as PatchOp) ? (rawOp as PatchOp) : "keep";

	const patch: IntentPatch = { op };

	if (typeof obj.phase === "string" && obj.phase.trim()) {
		patch.phase = normalizePhase(obj.phase);
	}
	if (typeof obj.prevVerdict === "string" && obj.prevVerdict.trim()) {
		patch.prevVerdict = cleanText(obj.prevVerdict, limits.verdict);
	}
	if (obj.prevOutcome === "done" || obj.prevOutcome === "rejected") {
		patch.prevOutcome = obj.prevOutcome;
	}
	if (typeof obj.intent === "string" && obj.intent.trim()) {
		patch.intent = cleanText(obj.intent, limits.intent);
	}
	if (typeof obj.hypothesis === "string" && obj.hypothesis.trim()) {
		patch.hypothesis = cleanText(obj.hypothesis, limits.hypothesis);
	}
	if (typeof obj.evidence === "string" && obj.evidence.trim()) {
		patch.evidence = cleanText(obj.evidence, limits.evidence);
	}
	if (typeof obj.nextPlan === "string" && obj.nextPlan.trim()) {
		patch.nextPlan = cleanText(obj.nextPlan, limits.nextPlan);
	}
	if (typeof obj.changeNote === "string" && obj.changeNote.trim()) {
		patch.changeNote = cleanText(obj.changeNote, limits.changeNote);
	}
	if (Array.isArray(obj.fileChanges)) {
		const notes: { path: string; why: string }[] = [];
		for (const item of obj.fileChanges) {
			if (!item || typeof item !== "object") continue;
			const rec = item as Record<string, unknown>;
			if (typeof rec.path === "string" && typeof rec.why === "string" && rec.path.trim() && rec.why.trim()) {
				notes.push({
					path: cleanText(rec.path, 80),
					why: cleanText(rec.why, limits.fileWhy),
				});
			}
		}
		if (notes.length > 0) patch.fileChanges = notes;
	}
	if (obj.warning === null) {
		patch.warning = null;
	} else if (typeof obj.warning === "string" && obj.warning.trim()) {
		patch.warning = cleanText(obj.warning, limits.warning);
	}

	return patch;
}

export function selectAutoSidecarModel(
	available: readonly Model<Api>[],
	fallbackModel?: Model<Api>,
): Model<Api> | undefined {
	if (available.length === 0) return fallbackModel;

	for (const pattern of AUTO_CHEAP_MODEL_PREFERENCES) {
		const match = available.find((m) => m.id.toLowerCase().includes(pattern));
		if (match) return match;
	}

	// Next best: lowest known non-zero token cost among available models
	const priced = available
		.filter((m) => typeof m.cost?.input === "number" && typeof m.cost?.output === "number")
		.sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output));
	if (priced[0]) return priced[0];

	return fallbackModel ?? available[0];
}

export function resolveSidecarModel(
	modelRegistry: ExtensionContext["modelRegistry"],
	config: RioConfig,
	fallbackModel?: Model<Api>,
): Model<Api> | undefined {
	const isAuto = !config.modelId || config.modelId.trim().toLowerCase() === "auto";
	if (isAuto) {
		return selectAutoSidecarModel(modelRegistry.getAvailable(), fallbackModel);
	}

	if (config.provider) {
		const exact = modelRegistry.find(config.provider, config.modelId);
		if (exact && modelRegistry.hasConfiguredAuth(exact)) {
			return exact;
		}
	}

	// Fallback: search available models with matching modelId
	const available = modelRegistry.getAvailable();
	const byId = available.find((m) => m.id === config.modelId);
	if (byId) return byId;

	return undefined;
}

export interface SidecarCallResult {
	patch: IntentPatch;
	inputTokens: number;
	outputTokens: number;
	cost: number;
	latencyMs: number;
	modelLabel: string;
}

export async function runSidecarAnalysis(
	modelRegistry: ExtensionContext["modelRegistry"],
	config: RioConfig,
	state: IntentState,
	delta: TurnDelta,
	signal?: AbortSignal,
	fallbackModel?: Model<Api>,
): Promise<SidecarCallResult> {
	const model = resolveSidecarModel(modelRegistry, config, fallbackModel);
	if (!model) {
		const target = config.provider ? `${config.provider}/${config.modelId}` : config.modelId || "auto";
		throw new Error(
			`No available sidecar model for "${target}". Run /rio model <provider/id> or /rio model auto.`,
		);
	}

	const resolvedLang = resolveOutputLanguage(config.language);
	const profile = DETAIL_PROFILES[config.detail];
	const systemPrompt = getSidecarSystemPrompt(config.detail, resolvedLang);
	const userPrompt = buildSidecarUserPrompt(state, delta, config.detail);
	const start = Date.now();

	const stream = modelRegistry.streamSimple(
		model,
		{
			systemPrompt,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: userPrompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			reasoning: "minimal",
			maxTokens: profile.maxTokens,
			cacheRetention: "none",
			sessionId: uuidv7(),
			signal,
		},
	);

	const message = await stream.result();
	const latencyMs = Date.now() - start;

	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(message.errorMessage || `Sidecar stopped: ${message.stopReason}`);
	}

	const rawText = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	const patch = parseIntentPatch(rawText, config.detail);
	if (!patch) {
		throw new Error(`Failed to parse JSON patch: ${cleanText(rawText, 90)}`);
	}

	return {
		patch,
		inputTokens: message.usage?.input ?? 0,
		outputTokens: message.usage?.output ?? 0,
		cost: message.usage?.cost?.total ?? 0,
		latencyMs,
		modelLabel: `${model.provider}/${model.id}`,
	};
}
