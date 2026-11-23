export type IntentPhase = "explore" | "plan" | "edit" | "verify" | "debug" | "done";

export type IntentStepStatus = "active" | "done" | "rejected" | "aborted";

export type PatchOp = "keep" | "push" | "resolve_and_push" | "pivot" | "done";

export type DetailLevel = "low" | "medium" | "high";

export const DETAIL_LEVELS: readonly DetailLevel[] = ["low", "medium", "high"] as const;

export interface ToolRecord {
	toolCallId: string;
	toolName: string;
	target: string;
	status: "running" | "ok" | "error";
	turnIndex?: number;
	durationMs?: number;
	errorSnippet?: string;
}

export interface IntentStep {
	id: number;
	phase: IntentPhase;
	status: IntentStepStatus;
	intent: string;
	hypothesis?: string;
	/** Concrete code/error/test evidence observed (populated primarily in high detail mode). */
	evidence?: string;
	/** Anticipated next move or fallback plan (populated primarily in high detail mode). */
	nextPlan?: string;
	verdict?: string;
	tools: ToolRecord[];
	startedAt: number;
	endedAt?: number;
	turnIndices: number[];
	runSeq?: number;
	/** True when created by Layer 0 before the first sidecar response arrives. */
	isPlaceholder?: boolean;
}

export interface TouchedFile {
	path: string;
	shortPath: string;
	action: "edited" | "written";
	editCount: number;
	addedLines: number;
	removedLines: number;
	lastNote?: string;
	lastTurnIndex: number;
	firstRunSeq?: number;
	lastRunSeq?: number;
}

export interface ArchivedTopic {
	id: number;
	goal: string;
	rawPrompt?: string;
	steps: IntentStep[];
	touchedFiles: TouchedFile[];
	startedAt: number;
	endedAt: number;
}

export interface IntentState {
	/** Tree root: the user's current request/question. */
	goal: string;
	rawPrompt?: string;
	runSeq: number;
	steps: IntentStep[];
	touchedFiles: TouchedFile[];
	history: ArchivedTopic[];
	warning?: string;
	isRunning: boolean;
	isAnalyzing: boolean;
	startedAt: number;
	lastUpdatedAt: number;
}

export interface FileChangeNote {
	path: string;
	why: string;
}

export interface IntentPatch {
	op: PatchOp;
	phase?: IntentPhase;
	prevVerdict?: string;
	prevOutcome?: "done" | "rejected";
	intent?: string;
	hypothesis?: string;
	evidence?: string;
	nextPlan?: string;
	changeNote?: string;
	fileChanges?: FileChangeNote[];
	warning?: string | null;
}

export interface ToolCallSummary {
	toolCallId: string;
	toolName: string;
	target: string;
	detail?: string;
}

export interface ToolOutcomeSummary {
	toolName: string;
	target: string;
	isError: boolean;
	snippet?: string;
}

export interface TurnDelta {
	turnIndex: number;
	thinking: string;
	assistantText: string;
	toolCalls: ToolCallSummary[];
	previousOutcomes: ToolOutcomeSummary[];
}

export interface SidecarStats {
	calls: number;
	failures: number;
	inputTokens: number;
	outputTokens: number;
	totalCost: number;
	lastLatencyMs?: number;
	avgLatencyMs?: number;
	lastError?: string;
	activeModelLabel?: string;
}

export interface RioConfig {
	enabled: boolean;
	/** Explicit provider name, or empty string when modelId is "auto". */
	provider: string;
	/** Explicit model ID, or "auto" to pick a fast/cheap available model automatically. */
	modelId: string;
	/** Output language: "en", "zh", "auto", or any BCP-47/language label (e.g. "ja", "es"). */
	language: string;
	/** Granularity of sidecar analysis and UI presentation. */
	detail: DetailLevel;
	showWidgetWhenIdle: boolean;
}

export const DEFAULT_CONFIG: RioConfig = {
	enabled: true,
	provider: "",
	modelId: "auto",
	language: "en",
	detail: "medium",
	showWidgetWhenIdle: true,
};

export const SNAPSHOT_ENTRY_TYPE = "pi-rio:snapshot";
export const WIDGET_KEY = "pi-rio";
