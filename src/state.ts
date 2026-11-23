import { DETAIL_PROFILES, isChineseUiLanguage } from "./prompts.ts";
import type {
	ArchivedTopic,
	DetailLevel,
	IntentPatch,
	IntentPhase,
	IntentState,
	IntentStep,
	ToolCallSummary,
	ToolRecord,
	TouchedFile,
} from "./types.ts";

const MAX_ARCHIVED_TOPICS = 12;

const VALID_PHASES: ReadonlySet<IntentPhase> = new Set([
	"explore",
	"plan",
	"edit",
	"verify",
	"debug",
	"done",
]);

export function createEmptyState(now = Date.now()): IntentState {
	return {
		goal: "",
		rawPrompt: undefined,
		runSeq: 0,
		steps: [],
		touchedFiles: [],
		history: [],
		warning: undefined,
		isRunning: false,
		isAnalyzing: false,
		startedAt: now,
		lastUpdatedAt: now,
	};
}

export function cleanText(value: string | undefined, maxLen: number): string {
	if (!value) return "";
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLen) return singleLine;
	return `${singleLine.slice(0, Math.max(1, maxLen - 1))}…`;
}

/** Format raw user message into a clean tree-root prompt (collapsing temp clipboard image paths). */
export function formatRootQuestion(rawPrompt: string | undefined, maxLen = 76, resolvedLang = "en"): string {
	const isZh = isChineseUiLanguage(resolvedLang);
	const fallback = isZh ? "执行新请求" : "New request";
	const imageTag = isZh ? "[图片]" : "[image]";
	if (!rawPrompt) return fallback;
	const stripped = rawPrompt
		.replace(/(?:\/[\w.~+-]+)+\/pi-clipboard-[\w-]+\.(?:png|jpe?g|webp|gif|bmp)/gi, imageTag)
		.replace(/\s+/g, " ")
		.trim();
	return cleanText(stripped, maxLen) || fallback;
}

export function normalizePhase(phase: unknown, fallback: IntentPhase = "explore"): IntentPhase {
	if (typeof phase === "string" && VALID_PHASES.has(phase as IntentPhase)) {
		return phase as IntentPhase;
	}
	return fallback;
}

export function inferPhaseFromTools(toolCalls: ToolCallSummary[]): IntentPhase {
	if (toolCalls.length === 0) return "plan";
	const names = toolCalls.map((t) => t.toolName.toLowerCase());
	if (names.some((n) => n === "edit" || n === "write")) return "edit";
	if (
		toolCalls.some(
			(t) =>
				t.toolName === "bash" &&
				/\b(test|vitest|jest|pytest|cargo test|go test|tsc|typecheck|lint|build)\b/i.test(t.target),
		)
	) {
		return "verify";
	}
	return "explore";
}

export function summarizeToolTarget(toolName: string, args: unknown): string {
	const obj = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	switch (toolName) {
		case "read":
		case "edit":
		case "write": {
			const rawPath = typeof obj.path === "string" ? obj.path : "";
			return shortenPath(rawPath) || toolName;
		}
		case "bash": {
			const cmd = typeof obj.command === "string" ? obj.command : "";
			return cleanText(cmd, 48) || "bash";
		}
		case "mcp": {
			const tool =
				typeof obj.tool === "string"
					? obj.tool
					: typeof obj.search === "string"
						? `search:${obj.search}`
						: "mcp";
			return cleanText(tool, 40);
		}
		default: {
			if (typeof obj.tool === "string") return cleanText(`${toolName}:${obj.tool}`, 44);
			if (typeof obj.path === "string") return shortenPath(obj.path);
			if (typeof obj.query === "string") return cleanText(obj.query, 40);
			if (typeof obj.command === "string") return cleanText(obj.command, 40);
			return toolName;
		}
	}
}

export function shortenPath(filePath: string): string {
	if (!filePath) return "";
	const normalized = filePath.replace(/^@/, "").replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length <= 2) return parts.join("/");
	return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function startNewRun(
	state: IntentState,
	rawPrompt: string,
	now = Date.now(),
	resolvedLang = "en",
): IntentState {
	const nextHistory = [...state.history];
	const prevFallback = isChineseUiLanguage(resolvedLang) ? "上一请求" : "Previous request";
	if (state.steps.length > 0 || state.touchedFiles.length > 0) {
		const archived: ArchivedTopic = {
			id: nextHistory.length + 1,
			goal: state.goal || prevFallback,
			rawPrompt: state.rawPrompt,
			steps: state.steps.map((s) => ({
				...s,
				status: s.status === "active" ? ("done" as const) : s.status,
				endedAt: s.endedAt ?? now,
				turnIndices: [...s.turnIndices],
				tools: s.tools.map((t) => ({ ...t })),
			})),
			touchedFiles: state.touchedFiles.map((f) => ({ ...f })),
			startedAt: state.startedAt,
			endedAt: now,
		};
		nextHistory.push(archived);
	}

	const trimmedHistory = nextHistory.slice(-MAX_ARCHIVED_TOPICS);

	return {
		goal: formatRootQuestion(rawPrompt, 76, resolvedLang),
		rawPrompt: formatRootQuestion(rawPrompt, 280, resolvedLang),
		runSeq: state.runSeq + 1,
		steps: [],
		touchedFiles: [],
		history: trimmedHistory,
		warning: undefined,
		isRunning: true,
		isAnalyzing: false,
		startedAt: now,
		lastUpdatedAt: now,
	};
}

export function summarizeToolDetail(toolName: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const obj = args as Record<string, unknown>;
	if (toolName === "edit") {
		if (Array.isArray(obj.edits) && obj.edits.length > 0) {
			const first = obj.edits[0] as Record<string, unknown> | undefined;
			const oldStr = typeof first?.oldText === "string" ? cleanText(first.oldText, 64) : "";
			const newStr = typeof first?.newText === "string" ? cleanText(first.newText, 64) : "";
			const extra = obj.edits.length > 1 ? ` (+${obj.edits.length - 1} edits)` : "";
			if (oldStr || newStr) return `${oldStr} => ${newStr}${extra}`;
		} else {
			const oldStr = typeof obj.oldText === "string" ? cleanText(obj.oldText, 64) : "";
			const newStr = typeof obj.newText === "string" ? cleanText(obj.newText, 64) : "";
			if (oldStr || newStr) return `${oldStr} => ${newStr}`;
		}
	} else if (toolName === "write") {
		const content = typeof obj.content === "string" ? obj.content : "";
		if (content) return `write ${countLines(content)} lines: ${cleanText(content, 84)}`;
	}
	return undefined;
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

export function extractFileMutation(
	toolName: string,
	args: unknown,
): { path: string; action: "edited" | "written"; addedLines: number; removedLines: number } | null {
	if (toolName !== "edit" && toolName !== "write") return null;
	if (!args || typeof args !== "object") return null;
	const obj = args as Record<string, unknown>;
	const rawPath = typeof obj.path === "string" ? obj.path.replace(/^@/, "").trim() : "";
	if (!rawPath) return null;

	if (toolName === "write") {
		const content = typeof obj.content === "string" ? obj.content : "";
		return {
			path: rawPath,
			action: "written",
			addedLines: countLines(content),
			removedLines: 0,
		};
	}

	let addedLines = 0;
	let removedLines = 0;
	if (Array.isArray(obj.edits)) {
		for (const item of obj.edits) {
			if (!item || typeof item !== "object") continue;
			const e = item as Record<string, unknown>;
			const oldStr = typeof e.oldText === "string" ? e.oldText : "";
			const newStr = typeof e.newText === "string" ? e.newText : "";
			if (oldStr !== newStr) {
				addedLines += countLines(newStr);
				removedLines += countLines(oldStr);
			}
		}
	} else {
		const oldStr = typeof obj.oldText === "string" ? obj.oldText : "";
		const newStr = typeof obj.newText === "string" ? obj.newText : "";
		if (oldStr !== newStr) {
			addedLines = countLines(newStr);
			removedLines = countLines(oldStr);
		}
	}

	return {
		path: rawPath,
		action: "edited",
		addedLines,
		removedLines,
	};
}

export function recordFileMutation(
	state: IntentState,
	mutation: { path: string; action: "edited" | "written"; addedLines: number; removedLines: number },
	turnIndex: number,
	now = Date.now(),
): void {
	const existing = state.touchedFiles.find((f) => f.path === mutation.path);
	const active = getActiveStep(state);
	const fallbackNote = active && !active.isPlaceholder && active.phase === "edit" ? active.intent : undefined;

	if (existing) {
		existing.editCount += 1;
		existing.addedLines += mutation.addedLines;
		existing.removedLines += mutation.removedLines;
		existing.lastTurnIndex = turnIndex;
		existing.lastRunSeq = state.runSeq;
		if (fallbackNote) existing.lastNote = fallbackNote;
	} else {
		const entry: TouchedFile = {
			path: mutation.path,
			shortPath: shortenPath(mutation.path) || mutation.path,
			action: mutation.action,
			editCount: 1,
			addedLines: mutation.addedLines,
			removedLines: mutation.removedLines,
			lastNote: fallbackNote,
			lastTurnIndex: turnIndex,
			firstRunSeq: state.runSeq,
			lastRunSeq: state.runSeq,
		};
		state.touchedFiles.push(entry);
	}
	state.lastUpdatedAt = now;
}

export function getActiveStep(state: IntentState): IntentStep | undefined {
	for (let i = state.steps.length - 1; i >= 0; i--) {
		if (state.steps[i]!.status === "active") return state.steps[i]!;
	}
	return undefined;
}

export function ensurePlaceholderStep(
	state: IntentState,
	turnIndex: number,
	toolCalls: ToolCallSummary[],
	now = Date.now(),
	resolvedLang = "en",
): IntentStep {
	const active = getActiveStep(state);
	if (active) {
		if (!active.turnIndices.includes(turnIndex)) active.turnIndices.push(turnIndex);
		return active;
	}

	const phase = inferPhaseFromTools(toolCalls);
	const isZh = isChineseUiLanguage(resolvedLang);
	const fallbackIntent =
		phase === "edit"
			? isZh
				? "正在修改代码"
				: "Editing files"
			: phase === "verify"
				? isZh
					? "正在运行验证检查"
					: "Running verification checks"
				: toolCalls.length > 0
					? isZh
						? "正在调研上下文"
						: "Exploring context"
					: isZh
						? "正在分析思路"
						: "Analyzing next move";

	const step: IntentStep = {
		id: state.steps.length + 1,
		phase,
		status: "active",
		intent: fallbackIntent,
		tools: [],
		startedAt: now,
		turnIndices: [turnIndex],
		runSeq: state.runSeq,
		isPlaceholder: true,
	};
	state.steps.push(step);
	state.lastUpdatedAt = now;
	return step;
}

export function recordToolStart(
	state: IntentState,
	toolCallId: string,
	toolName: string,
	args: unknown,
	turnIndex: number,
	now = Date.now(),
	resolvedLang = "en",
): void {
	const target = summarizeToolTarget(toolName, args);
	const step = ensurePlaceholderStep(state, turnIndex, [{ toolCallId, toolName, target }], now, resolvedLang);
	const existing = step.tools.find((t) => t.toolCallId === toolCallId);
	if (existing) {
		existing.status = "running";
		existing.target = target;
	} else {
		step.tools.push({
			toolCallId,
			toolName,
			target,
			status: "running",
			turnIndex,
		});
	}
	state.lastUpdatedAt = now;
}

export function recordToolEnd(
	state: IntentState,
	toolCallId: string,
	isError: boolean,
	durationMs?: number,
	errorSnippet?: string,
	now = Date.now(),
): void {
	for (let i = state.steps.length - 1; i >= 0; i--) {
		const record = state.steps[i]!.tools.find((t) => t.toolCallId === toolCallId);
		if (record) {
			record.status = isError ? "error" : "ok";
			if (durationMs !== undefined) record.durationMs = durationMs;
			if (isError && errorSnippet) record.errorSnippet = cleanText(errorSnippet, 100);
			state.lastUpdatedAt = now;
			return;
		}
	}
}

export function applyPatch(
	state: IntentState,
	patch: IntentPatch,
	turnIndex: number,
	now = Date.now(),
	detail: DetailLevel = "medium",
	resolvedLang = "en",
): void {
	const limits = DETAIL_PROFILES[detail].limits;

	if (patch.warning === null) {
		state.warning = undefined;
	} else if (typeof patch.warning === "string" && patch.warning.trim()) {
		state.warning = cleanText(patch.warning, limits.warning);
	}

	const note = patch.changeNote
		? cleanText(patch.changeNote, limits.changeNote)
		: patch.phase === "edit" && patch.intent
			? cleanText(patch.intent, limits.changeNote)
			: undefined;

	if (patch.fileChanges && patch.fileChanges.length > 0) {
		for (const fc of patch.fileChanges) {
			const needle = fc.path.replace(/^@/, "").replace(/\\/g, "/").toLowerCase();
			if (!needle || !fc.why) continue;
			const matched = state.touchedFiles.find((f) => {
				const full = f.path.replace(/\\/g, "/").toLowerCase();
				const short = f.shortPath.toLowerCase();
				return full === needle || short === needle || full.endsWith(`/${needle}`) || short.endsWith(needle);
			});
			if (matched) {
				matched.lastNote = cleanText(fc.why, limits.fileWhy);
			}
		}
	}

	if (note) {
		for (const file of state.touchedFiles) {
			if (file.lastTurnIndex === turnIndex || (!file.lastNote && turnIndex - file.lastTurnIndex <= 1)) {
				file.lastNote = note;
			}
		}
	}

	const active = getActiveStep(state);

	// Upgrade a Layer 0 placeholder in place instead of creating a duplicate step.
	if (active && active.isPlaceholder && patch.op !== "done") {
		active.isPlaceholder = false;
		if (patch.phase) active.phase = normalizePhase(patch.phase, active.phase);
		if (patch.intent) active.intent = cleanText(patch.intent, limits.intent);
		if (patch.hypothesis) active.hypothesis = cleanText(patch.hypothesis, limits.hypothesis);
		if (patch.evidence) active.evidence = cleanText(patch.evidence, limits.evidence);
		if (patch.nextPlan) active.nextPlan = cleanText(patch.nextPlan, limits.nextPlan);
		if (!active.turnIndices.includes(turnIndex)) active.turnIndices.push(turnIndex);
		state.lastUpdatedAt = now;
		return;
	}

	switch (patch.op) {
		case "keep": {
			if (active) {
				if (patch.phase) active.phase = normalizePhase(patch.phase, active.phase);
				if (patch.intent) active.intent = cleanText(patch.intent, limits.intent);
				if (patch.hypothesis) active.hypothesis = cleanText(patch.hypothesis, limits.hypothesis);
				if (patch.evidence) active.evidence = cleanText(patch.evidence, limits.evidence);
				if (patch.nextPlan) active.nextPlan = cleanText(patch.nextPlan, limits.nextPlan);
				if (patch.prevVerdict) active.verdict = cleanText(patch.prevVerdict, limits.verdict);
				if (!active.turnIndices.includes(turnIndex)) active.turnIndices.push(turnIndex);
			} else if (!state.isRunning && state.steps.length > 0) {
				const last = state.steps[state.steps.length - 1]!;
				if (patch.prevVerdict) last.verdict = cleanText(patch.prevVerdict, limits.verdict);
				if (patch.evidence) last.evidence = cleanText(patch.evidence, limits.evidence);
			} else if (patch.intent) {
				pushStep(state, patch, turnIndex, now, detail, resolvedLang);
			}
			break;
		}
		case "push": {
			if (active) {
				active.status = "done";
				active.endedAt = now;
				if (patch.prevVerdict) active.verdict = cleanText(patch.prevVerdict, limits.verdict);
			}
			pushStep(state, patch, turnIndex, now, detail, resolvedLang);
			break;
		}
		case "resolve_and_push": {
			if (active) {
				active.status = patch.prevOutcome === "rejected" ? "rejected" : "done";
				active.endedAt = now;
				if (patch.prevVerdict) active.verdict = cleanText(patch.prevVerdict, limits.verdict);
			}
			pushStep(state, patch, turnIndex, now, detail, resolvedLang);
			break;
		}
		case "pivot": {
			if (active) {
				active.status = "rejected";
				active.endedAt = now;
				if (patch.prevVerdict) active.verdict = cleanText(patch.prevVerdict, limits.verdict);
			}
			pushStep(state, patch, turnIndex, now, detail, resolvedLang);
			break;
		}
		case "done": {
			// Final turn's sidecar often arrives right after agent_settled already closed the last step.
			const target = active ?? state.steps[state.steps.length - 1];
			if (target) {
				const wasPlaceholder = Boolean(target.isPlaceholder);
				target.isPlaceholder = false;
				target.status = "done";
				target.endedAt = target.endedAt ?? now;
				if (patch.evidence) target.evidence = cleanText(patch.evidence, limits.evidence);
				if (patch.prevVerdict) {
					target.verdict = cleanText(patch.prevVerdict, limits.verdict);
				} else if (patch.intent && wasPlaceholder) {
					target.intent = cleanText(patch.intent, limits.intent);
				}
			}
			break;
		}
	}

	// Move current-turn tools from the just-closed step onto the newly pushed active step.
	const newActive = getActiveStep(state);
	if (newActive && active && newActive.id !== active.id) {
		const moved: ToolRecord[] = [];
		const kept: ToolRecord[] = [];
		for (const tool of active.tools) {
			if (tool.status === "running" || tool.turnIndex === turnIndex) {
				moved.push(tool);
			} else {
				kept.push(tool);
			}
		}
		if (moved.length > 0) {
			active.tools = kept;
			for (const tool of moved) {
				if (!newActive.tools.some((t) => t.toolCallId === tool.toolCallId)) {
					newActive.tools.push(tool);
				}
			}
		}
	}

	state.lastUpdatedAt = now;
}

function pushStep(
	state: IntentState,
	patch: IntentPatch,
	turnIndex: number,
	now: number,
	detail: DetailLevel,
	resolvedLang: string,
): void {
	const limits = DETAIL_PROFILES[detail].limits;
	const fallbackIntent = isChineseUiLanguage(resolvedLang) ? "推进下一步" : "Advance to next step";
	const step: IntentStep = {
		id: state.steps.length + 1,
		phase: normalizePhase(patch.phase, "explore"),
		status: "active",
		intent: cleanText(patch.intent, limits.intent) || fallbackIntent,
		hypothesis: patch.hypothesis ? cleanText(patch.hypothesis, limits.hypothesis) : undefined,
		evidence: patch.evidence ? cleanText(patch.evidence, limits.evidence) : undefined,
		nextPlan: patch.nextPlan ? cleanText(patch.nextPlan, limits.nextPlan) : undefined,
		tools: [],
		startedAt: now,
		turnIndices: [turnIndex],
		runSeq: state.runSeq,
		isPlaceholder: false,
	};
	state.steps.push(step);
}

export function finalizeRun(state: IntentState, aborted: boolean, now = Date.now()): void {
	state.isRunning = false;
	if (aborted) {
		state.isAnalyzing = false;
	}
	for (const step of state.steps) {
		if (step.status === "active") {
			step.status = aborted ? "aborted" : "done";
			step.endedAt = now;
		}
		for (const tool of step.tools) {
			if (tool.status === "running") {
				tool.status = aborted ? "error" : "ok";
			}
		}
	}
	state.lastUpdatedAt = now;
}

export function cloneSnapshot(state: IntentState): IntentState {
	return {
		goal: state.goal,
		rawPrompt: state.rawPrompt,
		runSeq: state.runSeq,
		warning: state.warning,
		isRunning: false,
		isAnalyzing: false,
		startedAt: state.startedAt,
		lastUpdatedAt: state.lastUpdatedAt,
		touchedFiles: state.touchedFiles.map((f) => ({ ...f })),
		steps: state.steps.map((s) => ({
			...s,
			turnIndices: [...s.turnIndices],
			tools: s.tools.map((t) => ({ ...t })),
		})),
		history: state.history.map((h) => ({
			...h,
			touchedFiles: h.touchedFiles.map((f) => ({ ...f })),
			steps: h.steps.map((s) => ({
				...s,
				turnIndices: [...s.turnIndices],
				tools: s.tools.map((t) => ({ ...t })),
			})),
		})),
	};
}
