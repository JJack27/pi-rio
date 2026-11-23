import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { pruneStaleLiveFiles, publishLiveSession } from "./live.ts";
import { normalizeDetailLevel, resolveOutputLanguage } from "./prompts.ts";
import { resolveSidecarModel, runSidecarAnalysis } from "./sidecar.ts";
import {
	applyPatch,
	cleanText,
	cloneSnapshot,
	createEmptyState,
	ensurePlaceholderStep,
	extractFileMutation,
	finalizeRun,
	recordFileMutation,
	recordToolEnd,
	recordToolStart,
	startNewRun,
	summarizeToolDetail,
	summarizeToolTarget,
} from "./state.ts";
import {
	DEFAULT_CONFIG,
	type DetailLevel,
	type FileChangeNote,
	type IntentState,
	type RioConfig,
	SNAPSHOT_ENTRY_TYPE,
	type SidecarStats,
	type ToolCallSummary,
	type ToolOutcomeSummary,
	type TurnDelta,
	WIDGET_KEY,
} from "./types.ts";
import { RioOverlayComponent, renderWidgetLines } from "./ui.ts";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "rio.json");

const LANGUAGE_COMPLETIONS: AutocompleteItem[] = [
	{ value: "lang en", label: "en", description: "English output and UI" },
	{ value: "lang zh", label: "zh", description: "Simplified Chinese output and UI" },
	{ value: "lang auto", label: "auto", description: "Detect from LC_ALL / LANG (fallback: en)" },
	{ value: "lang ja", label: "ja", description: "Japanese sidecar output" },
	{ value: "lang ko", label: "ko", description: "Korean sidecar output" },
	{ value: "lang es", label: "es", description: "Spanish sidecar output" },
	{ value: "lang fr", label: "fr", description: "French sidecar output" },
	{ value: "lang de", label: "de", description: "German sidecar output" },
];

const DETAIL_COMPLETIONS: AutocompleteItem[] = [
	{ value: "detail low", label: "low", description: "Minimal milestone ticker, lowest token usage" },
	{ value: "detail medium", label: "medium", description: "Balanced steps, hypotheses, verdicts & file rationale (default)" },
	{ value: "detail high", label: "high", description: "Deep flight recorder with evidence, symbols & next-step plan" },
];

export function loadConfig(configPath = CONFIG_PATH): RioConfig {
	try {
		if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<RioConfig>;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			provider: typeof raw.provider === "string" ? raw.provider.trim() : DEFAULT_CONFIG.provider,
			modelId: typeof raw.modelId === "string" && raw.modelId.trim() ? raw.modelId.trim() : DEFAULT_CONFIG.modelId,
			language:
				typeof raw.language === "string" && raw.language.trim() ? raw.language.trim() : DEFAULT_CONFIG.language,
			detail: normalizeDetailLevel(raw.detail, DEFAULT_CONFIG.detail),
			showWidgetWhenIdle:
				typeof raw.showWidgetWhenIdle === "boolean"
					? raw.showWidgetWhenIdle
					: DEFAULT_CONFIG.showWidgetWhenIdle,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: RioConfig, configPath = CONFIG_PATH): void {
	try {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
	} catch {
		// Best-effort persistence
	}
}

function formatConfiguredModel(config: RioConfig): string {
	if (!config.modelId || config.modelId.toLowerCase() === "auto") return "auto";
	return config.provider ? `${config.provider}/${config.modelId}` : config.modelId;
}

function extractResultText(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (item && typeof item === "object" && (item as { type?: string }).type === "text") {
			const text = (item as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) {
				parts.push(text.trim());
			}
		}
	}
	return parts.join("\n");
}

function extractAssistantDelta(
	content: unknown,
	turnIndex: number,
	previousOutcomes: ToolOutcomeSummary[],
): TurnDelta {
	const thinkingParts: string[] = [];
	const textParts: string[] = [];
	const toolCalls: ToolCallSummary[] = [];

	if (Array.isArray(content)) {
		for (const raw of content) {
			if (!raw || typeof raw !== "object") continue;
			const block = raw as Record<string, unknown>;
			if (block.type === "thinking" && typeof block.thinking === "string") {
				thinkingParts.push(block.thinking);
			} else if (block.type === "text" && typeof block.text === "string") {
				textParts.push(block.text);
			} else if (block.type === "toolCall" && typeof block.name === "string") {
				const toolCallId = typeof block.id === "string" ? block.id : `tc-${turnIndex}-${toolCalls.length}`;
				toolCalls.push({
					toolCallId,
					toolName: block.name,
					target: summarizeToolTarget(block.name, block.arguments),
					detail: summarizeToolDetail(block.name, block.arguments),
				});
			}
		}
	}

	return {
		turnIndex,
		thinking: thinkingParts.join("\n").trim(),
		assistantText: textParts.join("\n").trim(),
		toolCalls,
		previousOutcomes,
	};
}

function reconstructStateFromBranch(ctx: ExtensionContext): IntentState {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
		if (entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE && entry.data) {
			const snap = entry.data as Partial<IntentState>;
			if (typeof snap.goal === "string" && Array.isArray(snap.steps)) {
				return {
					goal: snap.goal,
					rawPrompt: typeof snap.rawPrompt === "string" ? snap.rawPrompt : undefined,
					runSeq: typeof snap.runSeq === "number" ? snap.runSeq : 1,
					steps: snap.steps,
					touchedFiles: Array.isArray(snap.touchedFiles) ? snap.touchedFiles : [],
					history: Array.isArray(snap.history) ? snap.history : [],
					warning: snap.warning,
					isRunning: false,
					isAnalyzing: false,
					startedAt: typeof snap.startedAt === "number" ? snap.startedAt : Date.now(),
					lastUpdatedAt: typeof snap.lastUpdatedAt === "number" ? snap.lastUpdatedAt : Date.now(),
				};
			}
		}
	}
	return createEmptyState();
}

export default function piRioExtension(pi: ExtensionAPI) {
	let config: RioConfig = loadConfig();
	let state: IntentState = createEmptyState();
	let stats: SidecarStats = {
		calls: 0,
		failures: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalCost: 0,
		activeModelLabel: formatConfiguredModel(config),
	};
	let totalLatencyMs = 0;

	let currentTurnIndex = 0;
	let currentTurnOutcomes: ToolOutcomeSummary[] = [];
	const toolTargetsById = new Map<
		string,
		{
			toolName: string;
			target: string;
			mutation: ReturnType<typeof extractFileMutation>;
			turnIndex: number;
		}
	>();
	const turnFileNotes = new Map<number, { changeNote?: string; fileChanges?: FileChangeNote[] }>();

	let lastCtx: ExtensionContext | null = null;
	let activeAbort: AbortController | null = null;
	let inFlight = false;
	const pendingQueue: TurnDelta[] = [];
	let runGeneration = 0;

	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | null = null;
	let widgetMounted = false;
	let widgetRequestRender: (() => void) | null = null;
	let activeOverlay: { component: RioOverlayComponent; requestRender: () => void } | null = null;

	function currentResolvedLang(): string {
		return resolveOutputLanguage(config.language);
	}

	function stopSpinner(): void {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = null;
		}
	}

	function syncSpinner(): void {
		if (state.isAnalyzing && config.enabled) {
			if (!spinnerTimer) {
				spinnerTimer = setInterval(() => {
					spinnerIndex = (spinnerIndex + 1) % 10;
					refreshUi(undefined, true);
				}, 110);
			}
		} else {
			stopSpinner();
		}
	}

	function shouldShowWidget(): boolean {
		if (!config.enabled) return false;
		if (!state.goal && state.steps.length === 0) return false;
		if (!state.isRunning && !config.showWidgetWhenIdle) return false;
		return true;
	}

	function syncLive(ctx?: ExtensionContext, alive = true): void {
		const targetCtx = ctx ?? lastCtx;
		if (!targetCtx) return;
		const sessionId = targetCtx.sessionManager.getSessionId() || `pid-${process.pid}`;
		publishLiveSession({
			sessionId,
			cwd: targetCtx.cwd,
			alive,
			detail: config.detail,
			language: currentResolvedLang(),
			stats,
			state,
		});
	}

	function refreshUi(ctx?: ExtensionContext, skipLive = false): void {
		const targetCtx = ctx ?? lastCtx ?? undefined;
		if (!skipLive) {
			syncLive(targetCtx, true);
		}
		if (!targetCtx || !targetCtx.hasUI) return;

		if (!shouldShowWidget()) {
			if (widgetMounted) {
				targetCtx.ui.setWidget(WIDGET_KEY, undefined);
				widgetMounted = false;
				widgetRequestRender = null;
			}
		} else if (!widgetMounted) {
			widgetMounted = true;
			targetCtx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					widgetRequestRender = () => tui.requestRender();
					return {
						render(width: number): string[] {
							if (!shouldShowWidget()) return [];
							return renderWidgetLines(state, theme, width, spinnerIndex, {
								detail: config.detail,
								resolvedLang: currentResolvedLang(),
							});
						},
						invalidate(): void {
							// Stateless render reads latest state, config & theme directly
						},
					};
				},
				{ placement: "aboveEditor" },
			);
		} else {
			widgetRequestRender?.();
		}

		if (activeOverlay) {
			activeOverlay.component.invalidate();
			activeOverlay.requestRender();
		}
	}

	function cancelInFlight(): void {
		pendingQueue.length = 0;
		if (activeAbort) {
			activeAbort.abort();
			activeAbort = null;
		}
		inFlight = false;
		state.isAnalyzing = false;
		syncSpinner();
	}

	function persistSnapshot(): void {
		if (!state.goal && state.steps.length === 0) return;
		try {
			pi.appendEntry(SNAPSHOT_ENTRY_TYPE, cloneSnapshot(state));
		} catch {
			// Ignore if session is not writable during teardown
		}
	}

	function hasMutationTool(delta: TurnDelta): boolean {
		return delta.toolCalls.some((t) => t.toolName === "edit" || t.toolName === "write");
	}

	function enqueueSidecar(delta: TurnDelta, ctx: ExtensionContext): void {
		if (!config.enabled) return;

		if (inFlight) {
			// Preserve edit/write turns; coalesce consecutive read-only turns so the queue stays bounded
			const last = pendingQueue[pendingQueue.length - 1];
			if (last && !hasMutationTool(last) && !hasMutationTool(delta)) {
				pendingQueue[pendingQueue.length - 1] = delta;
			} else {
				pendingQueue.push(delta);
				if (pendingQueue.length > 4) {
					const dropIdx = pendingQueue.findIndex((item) => !hasMutationTool(item));
					pendingQueue.splice(dropIdx >= 0 ? dropIdx : 0, 1);
				}
			}
			return;
		}

		void drainSidecar(delta, ctx, runGeneration);
	}

	async function drainSidecar(firstDelta: TurnDelta, ctx: ExtensionContext, generation: number): Promise<void> {
		let next: TurnDelta | null = firstDelta;
		inFlight = true;
		state.isAnalyzing = true;
		syncSpinner();
		refreshUi(ctx);

		try {
			while (next && generation === runGeneration && config.enabled) {
				const delta = next;
				next = null;

				const controller = new AbortController();
				activeAbort = controller;

				try {
					const result = await runSidecarAnalysis(
						ctx.modelRegistry,
						config,
						state,
						delta,
						controller.signal,
						ctx.model,
					);

					if (generation !== runGeneration) break;

					stats.calls += 1;
					stats.inputTokens += result.inputTokens;
					stats.outputTokens += result.outputTokens;
					stats.totalCost += result.cost;
					stats.lastLatencyMs = result.latencyMs;
					totalLatencyMs += result.latencyMs;
					stats.avgLatencyMs = totalLatencyMs / stats.calls;
					stats.activeModelLabel = result.modelLabel;
					stats.lastError = undefined;

					applyPatch(state, result.patch, delta.turnIndex, Date.now(), config.detail, currentResolvedLang());
					if (result.patch.changeNote || result.patch.fileChanges?.length) {
						turnFileNotes.set(delta.turnIndex, {
							changeNote: result.patch.changeNote,
							fileChanges: result.patch.fileChanges,
						});
					}
					persistSnapshot();
					refreshUi(ctx);
				} catch (err) {
					if (controller.signal.aborted || generation !== runGeneration) {
						break;
					}
					stats.failures += 1;
					stats.lastError = err instanceof Error ? cleanText(err.message, 100) : String(err);
					refreshUi(ctx);
				} finally {
					if (activeAbort === controller) {
						activeAbort = null;
					}
				}

				if (pendingQueue.length > 0 && generation === runGeneration) {
					next = pendingQueue.shift() ?? null;
				}
			}
		} finally {
			inFlight = false;
			state.isAnalyzing = false;
			syncSpinner();
			refreshUi(ctx);
		}
	}

	async function openOverlay(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("RIO overlay is only available in TUI mode.", "warning");
			return;
		}

		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				const component = new RioOverlayComponent(
					() => state,
					() => stats,
					() => ({ detail: config.detail, resolvedLang: currentResolvedLang() }),
					theme,
					() => tui.requestRender(),
					() => {
						activeOverlay = null;
						done();
					},
				);
				activeOverlay = { component, requestRender: () => tui.requestRender() };
				return component;
			},
			{
				overlay: true,
				overlayOptions: {
					width: "85%",
					maxHeight: "82%",
					anchor: "center",
				},
			},
		);
		activeOverlay = null;
	}

	// ---- Lifecycle Hooks ----

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		config = loadConfig();
		const resolved = resolveSidecarModel(ctx.modelRegistry, config, ctx.model);
		stats.activeModelLabel = resolved ? `${resolved.provider}/${resolved.id}` : formatConfiguredModel(config);
		state = reconstructStateFromBranch(ctx);
		widgetMounted = false;
		widgetRequestRender = null;
		pruneStaleLiveFiles();
		refreshUi(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		lastCtx = ctx;
		cancelInFlight();
		state = reconstructStateFromBranch(ctx);
		refreshUi(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		cancelInFlight();
		stopSpinner();
		syncLive(ctx, false);
		if (ctx.hasUI && widgetMounted) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		widgetMounted = false;
		widgetRequestRender = null;
		activeOverlay = null;
		lastCtx = null;
	});

	pi.on("before_agent_start", (event, ctx) => {
		lastCtx = ctx;
		if (!config.enabled) return;
		if (event.messageType !== "user") return;

		cancelInFlight();
		runGeneration += 1;
		currentTurnIndex = 0;
		currentTurnOutcomes = [];
		toolTargetsById.clear();
		turnFileNotes.clear();

		state = startNewRun(state, event.prompt ?? "", Date.now(), currentResolvedLang());
		refreshUi(ctx);
	});

	pi.on("turn_start", (event, ctx) => {
		lastCtx = ctx;
		currentTurnIndex = event.turnIndex;
	});

	pi.on("message_end", (event, ctx) => {
		lastCtx = ctx;
		if (!config.enabled) return;
		if (event.message.role !== "assistant") return;

		const previousOutcomes = currentTurnOutcomes;
		currentTurnOutcomes = [];

		const delta = extractAssistantDelta(event.message.content, currentTurnIndex, previousOutcomes);

		// Layer 0 cost guard: skip pure chitchat turns with no tools and no existing trace
		if (delta.toolCalls.length === 0 && state.steps.length === 0) {
			return;
		}

		// Layer 0 immediate feedback while sidecar runs asynchronously
		if (delta.toolCalls.length > 0) {
			ensurePlaceholderStep(state, currentTurnIndex, delta.toolCalls, Date.now(), currentResolvedLang());
			refreshUi(ctx);
		}

		// Fire sidecar asynchronously (never await inside message_end)
		enqueueSidecar(delta, ctx);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		lastCtx = ctx;
		if (!config.enabled) return;
		// Skip nested sub-calls from codemode to avoid visual noise
		if (event.parentToolCallId) return;

		const target = summarizeToolTarget(event.toolName, event.args);
		const mutation = extractFileMutation(event.toolName, event.args);
		toolTargetsById.set(event.toolCallId, {
			toolName: event.toolName,
			target,
			mutation,
			turnIndex: currentTurnIndex,
		});
		recordToolStart(state, event.toolCallId, event.toolName, event.args, currentTurnIndex, Date.now(), currentResolvedLang());
		refreshUi(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		lastCtx = ctx;
		if (!config.enabled) return;
		if (event.parentToolCallId) return;

		const rawText = extractResultText(event.result);
		const errorSnippet = event.isError ? cleanText(rawText, 160) : undefined;

		recordToolEnd(state, event.toolCallId, event.isError, event.durationMs, errorSnippet);

		const meta = toolTargetsById.get(event.toolCallId);
		if (!event.isError && meta?.mutation) {
			recordFileMutation(state, meta.mutation, meta.turnIndex);
			const savedNotes = turnFileNotes.get(meta.turnIndex);
			if (savedNotes) {
				applyPatch(
					state,
					{
						op: "keep",
						changeNote: savedNotes.changeNote,
						fileChanges: savedNotes.fileChanges,
					},
					meta.turnIndex,
					Date.now(),
					config.detail,
					currentResolvedLang(),
				);
			}
		}
		const target = meta?.target ?? event.toolName;
		const outcomeSnippet = event.isError
			? errorSnippet
			: event.toolName === "bash" && rawText
				? cleanText(rawText, config.detail === "high" ? 220 : 110)
				: undefined;

		currentTurnOutcomes.push({
			toolName: event.toolName,
			target,
			isError: event.isError,
			snippet: outcomeSnippet,
		});

		refreshUi(ctx);
	});

	pi.on("agent_settled", (event, ctx) => {
		lastCtx = ctx;
		if (!config.enabled) return;

		if (event.aborted) {
			cancelInFlight();
		}
		finalizeRun(state, event.aborted);
		persistSnapshot();
		refreshUi(ctx);
	});

	// ---- Shortcut & Command ----

	pi.registerShortcut("ctrl+shift+i", {
		description: "Open pi-rio reasoning trail overlay",
		handler: async (ctx) => {
			lastCtx = ctx;
			await openOverlay(ctx);
		},
	});

	pi.registerCommand("rio", {
		description: "pi-rio: inspect reasoning trail, switch model, output language, or detail level",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const subcommands: AutocompleteItem[] = [
				{ value: "model", label: "model <provider/id|auto>", description: "View or switch default sidecar model" },
				{ value: "lang", label: "lang <en|zh|auto|code>", description: "View or switch sidecar output language" },
				{ value: "detail", label: "detail <low|medium|high>", description: "View or switch trail granularity" },
				{ value: "toggle", label: "toggle", description: "Pause or resume live tracking" },
				{ value: "on", label: "on", description: "Enable live tracking" },
				{ value: "off", label: "off", description: "Pause live tracking" },
				{ value: "status", label: "status", description: "Show config, calls, tokens, cost & latency" },
				{ value: "clear", label: "clear", description: "Clear the current reasoning trail" },
			];

			const trimmed = prefix.trimStart();

			if (trimmed.startsWith("model ")) {
				const modelPrefix = trimmed.slice("model ".length).toLowerCase();
				const items: AutocompleteItem[] = [];
				if ("auto".includes(modelPrefix)) {
					items.push({ value: "model auto", label: "auto", description: "Auto-pick cheapest available model" });
				}
				if (lastCtx) {
					const matches = lastCtx.modelRegistry
						.getAvailable()
						.map((m) => `${m.provider}/${m.id}`)
						.filter((id) => id.toLowerCase().includes(modelPrefix))
						.slice(0, 12)
						.map((id) => ({ value: `model ${id}`, label: id }));
					items.push(...matches);
				}
				return items.length > 0 ? items : null;
			}

			if (trimmed.startsWith("lang ") || trimmed.startsWith("language ")) {
				const kw = trimmed.startsWith("language ") ? "language " : "lang ";
				const argPrefix = trimmed.slice(kw.length).toLowerCase();
				const matches = LANGUAGE_COMPLETIONS.filter(
					(item) => item.label.startsWith(argPrefix) || item.description?.toLowerCase().includes(argPrefix),
				).map((item) => ({ ...item, value: `${kw}${item.label}` }));
				return matches.length > 0 ? matches : null;
			}

			if (
				trimmed.startsWith("detail ") ||
				trimmed.startsWith("level ") ||
				trimmed.startsWith("granularity ")
			) {
				const kw = trimmed.startsWith("granularity ")
					? "granularity "
					: trimmed.startsWith("level ")
						? "level "
						: "detail ";
				const argPrefix = trimmed.slice(kw.length).toLowerCase();
				const matches = DETAIL_COMPLETIONS.filter((item) => item.label.startsWith(argPrefix)).map((item) => ({
					...item,
					value: `${kw}${item.label}`,
				}));
				return matches.length > 0 ? matches : null;
			}

			const filtered = subcommands.filter((item) => item.value.startsWith(trimmed.toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "").toLowerCase();

			if (!sub) {
				await openOverlay(ctx);
				return;
			}

			if (sub === "on" || sub === "off" || sub === "toggle") {
				config.enabled = sub === "on" ? true : sub === "off" ? false : !config.enabled;
				saveConfig(config);
				if (!config.enabled) cancelInFlight();
				refreshUi(ctx);
				ctx.ui.notify(`pi-rio ${config.enabled ? "enabled" : "paused"}.`, "info");
				return;
			}

			if (sub === "clear") {
				cancelInFlight();
				state = createEmptyState();
				refreshUi(ctx);
				ctx.ui.notify("Cleared current reasoning trail.", "info");
				return;
			}

			if (sub === "model") {
				const spec = parts[1];
				if (!spec) {
					const resolved = resolveSidecarModel(ctx.modelRegistry, config, ctx.model);
					const resolvedLabel = resolved ? `${resolved.provider}/${resolved.id}` : "none found";
					const modeInfo =
						config.modelId.toLowerCase() === "auto"
							? `auto (resolved: ${resolvedLabel})`
							: formatConfiguredModel(config);
					ctx.ui.notify(
						`Default sidecar model: ${modeInfo}\nUse /rio model <provider>/<id> or /rio model auto`,
						"info",
					);
					return;
				}
				if (spec.toLowerCase() === "auto") {
					config.provider = "";
					config.modelId = "auto";
					saveConfig(config);
					const resolved = resolveSidecarModel(ctx.modelRegistry, config, ctx.model);
					stats.activeModelLabel = resolved ? `${resolved.provider}/${resolved.id}` : "auto";
					refreshUi(ctx);
					ctx.ui.notify(
						`Default sidecar model set to auto${resolved ? ` (using ${resolved.provider}/${resolved.id})` : ""}.`,
						"info",
					);
					return;
				}
				const slash = spec.indexOf("/");
				if (slash <= 0 || slash === spec.length - 1) {
					ctx.ui.notify("Expected format: <provider>/<modelId> (e.g. openai/gpt-4.1-mini) or auto.", "warning");
					return;
				}
				const provider = spec.slice(0, slash);
				const modelId = spec.slice(slash + 1);
				const found = ctx.modelRegistry.find(provider, modelId);
				if (!found) {
					ctx.ui.notify(`Model not found in registry: ${provider}/${modelId}`, "error");
					return;
				}
				if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
					ctx.ui.notify(`Model ${provider}/${modelId} has no configured auth.`, "warning");
					return;
				}
				config.provider = provider;
				config.modelId = modelId;
				stats.activeModelLabel = `${provider}/${modelId}`;
				saveConfig(config);
				refreshUi(ctx);
				ctx.ui.notify(`Default sidecar model switched to ${provider}/${modelId}.`, "info");
				return;
			}

			if (sub === "lang" || sub === "language") {
				const target = parts.slice(1).join(" ").trim();
				if (!target) {
					const resolved = currentResolvedLang();
					const note = config.language === "auto" ? `auto (resolved: ${resolved})` : config.language;
					ctx.ui.notify(
						`Output language: ${note}\nUse /rio lang <en|zh|auto|ja|ko|es|fr|de|...>`,
						"info",
					);
					return;
				}
				config.language = target;
				saveConfig(config);
				const resolved = currentResolvedLang();
				refreshUi(ctx);
				ctx.ui.notify(
					`Output language set to ${config.language}${config.language.toLowerCase() === "auto" ? ` (resolved: ${resolved})` : ""}.`,
					"info",
				);
				return;
			}

			if (sub === "detail" || sub === "level" || sub === "granularity") {
				const rawLevel = parts[1];
				if (!rawLevel) {
					ctx.ui.notify(
						`Detail granularity: ${config.detail}\nOptions: low (minimal milestones) | medium (balanced, default) | high (deep evidence & next plan)\nUse /rio detail <low|medium|high>`,
						"info",
					);
					return;
				}
				const lower = rawLevel.toLowerCase();
				const validInputs = new Set(["low", "l", "min", "minimal", "medium", "m", "med", "normal", "default", "high", "h", "max", "verbose", "detailed"]);
				if (!validInputs.has(lower)) {
					ctx.ui.notify(`Invalid detail level "${rawLevel}". Choose low, medium, or high.`, "warning");
					return;
				}
				const normalized: DetailLevel = normalizeDetailLevel(lower, config.detail);
				config.detail = normalized;
				saveConfig(config);
				refreshUi(ctx);
				ctx.ui.notify(`Detail granularity set to ${normalized}.`, "info");
				return;
			}

			if (sub === "status" || sub === "debug") {
				const avg = stats.avgLatencyMs ? `${Math.round(stats.avgLatencyMs)}ms` : "-";
				const resolved = resolveSidecarModel(ctx.modelRegistry, config, ctx.model);
				const modelInfo =
					config.modelId.toLowerCase() === "auto"
						? `auto (${resolved ? `${resolved.provider}/${resolved.id}` : "none"})`
						: formatConfiguredModel(config);
				const langInfo =
					config.language.toLowerCase() === "auto"
						? `auto (${currentResolvedLang()})`
						: config.language;
				const lines = [
					`Status: ${config.enabled ? "enabled" : "paused"} | Model: ${modelInfo}`,
					`Language: ${langInfo} | Detail: ${config.detail}`,
					`Calls: ${stats.calls} ok / ${stats.failures} failed | Tokens: ${stats.inputTokens} in / ${stats.outputTokens} out`,
					`Cost: $${stats.totalCost.toFixed(5)} | Avg latency: ${avg}`,
				];
				if (stats.lastError) lines.push(`Last error: ${stats.lastError}`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			ctx.ui.notify(
				"Usage: /rio [model <provider/id|auto> | lang <en|zh|auto|code> | detail <low|medium|high> | toggle|on|off | status | clear]",
				"info",
			);
		},
	});
}
