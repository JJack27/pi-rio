import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isChineseUiLanguage } from "./prompts.ts";
import type {
	DetailLevel,
	IntentPhase,
	IntentState,
	IntentStep,
	SidecarStats,
	ToolRecord,
	TouchedFile,
} from "./types.ts";

export interface UiRenderOptions {
	detail: DetailLevel;
	resolvedLang: string;
}

interface UiStrings {
	phases: Record<IntentPhase, string>;
	running: string;
	done: string;
	preparing: string;
	stepsUnit: (n: number) => string;
	historyUnit: (n: number) => string;
	expandHint: string;
	waitingThinking: string;
	editedFilesHeader: (n: number) => string;
	editedFilesSub: string;
	moreFiles: (n: number) => string;
	moreEarlierFiles: (n: number) => string;
	toolErrors: (n: number) => string;
	toolsCount: (n: number) => string;
	hypLabel: string;
	evidLabel: string;
	nextLabel: string;
	verdictLabel: string;
	overlayTitle: string;
	topicBadge: (index: number, total: number, archived: boolean) => string;
	noPromptYet: string;
	warningPrefix: string;
	emptyBody: string;
	statsLine: (calls: number, inTok: number, outTok: number, cost: string, avg: string) => string;
	lastErrorPrefix: string;
	helpSwitch: string;
	helpCore: string;
	executingFallback: string;
}

const EN_STRINGS: UiStrings = {
	phases: {
		explore: "explore",
		plan: "plan",
		edit: "edit",
		verify: "verify",
		debug: "debug",
		done: "done",
	},
	running: "live",
	done: "idle",
	preparing: "starting",
	stepsUnit: (n) => `${n} ${n === 1 ? "step" : "steps"}`,
	historyUnit: (n) => `${n} prev`,
	expandHint: "Ctrl+Shift+I",
	waitingThinking: "⏳ Waiting for sidecar analysis…",
	editedFilesHeader: (n) => `Edited (${n})`,
	editedFilesSub: "· where + why",
	moreFiles: (n) => `(+${n} ${n === 1 ? "file" : "files"})`,
	moreEarlierFiles: (n) => `… and ${n} earlier edited ${n === 1 ? "file" : "files"}`,
	toolErrors: (n) => `${n} err`,
	toolsCount: (n) => `(${n} ${n === 1 ? "tool" : "tools"})`,
	hypLabel: "Hyp:",
	evidLabel: "Evid:",
	nextLabel: "Next:",
	verdictLabel: "Verdict:",
	overlayTitle: "🧭 RIO Trail",
	topicBadge: (idx, total, archived) => `[Request ${idx}/${total} · ${archived ? "History" : "Live"}]`,
	noPromptYet: "(no request yet)",
	warningPrefix: "⚠ Alert:",
	emptyBody: "No trail recorded yet. Send a task to the agent to begin live tracking.",
	statsLine: (calls, inTok, outTok, cost, avg) =>
		`Calls ${calls} · ${inTok}in/${outTok}out · ${cost} · avg ${avg}`,
	lastErrorPrefix: "Last error:",
	helpSwitch: "←/→ History · ",
	helpCore: "↑/↓ Select · Enter Expand · a All · Esc Close",
	executingFallback: "Running",
};

const ZH_STRINGS: UiStrings = {
	phases: {
		explore: "调研",
		plan: "规划",
		edit: "修改",
		verify: "验证",
		debug: "排错",
		done: "收尾",
	},
	running: "运行中",
	done: "已完成",
	preparing: "准备中",
	stepsUnit: (n) => `${n}步`,
	historyUnit: (n) => `${n}历史`,
	expandHint: "Ctrl+Shift+I 展开",
	waitingThinking: "⏳ 等待模型分析本步意图…",
	editedFilesHeader: (n) => `已改文件 (${n})`,
	editedFilesSub: "· 改了哪 + 为什么改",
	moreFiles: (n) => `(+${n}文件)`,
	moreEarlierFiles: (n) => `… 另有 ${n} 个较早改动文件`,
	toolErrors: (n) => `${n}错`,
	toolsCount: (n) => `(${n}个工具)`,
	hypLabel: "假设:",
	evidLabel: "依据:",
	nextLabel: "下步:",
	verdictLabel: "结论:",
	overlayTitle: "🧭 RIO 追踪树",
	topicBadge: (idx, total, archived) => `[请求 ${idx}/${total} · ${archived ? "历史" : "当前"}]`,
	noPromptYet: "(暂无请求)",
	warningPrefix: "⚠ 提醒:",
	emptyBody: "还没有追踪记录。发一条任务给 Agent 后这里会实时更新。",
	statsLine: (calls, inTok, outTok, cost, avg) =>
		`调用 ${calls}次 · ${inTok}in/${outTok}out · ${cost} · 均值 ${avg}`,
	lastErrorPrefix: "最近错误:",
	helpSwitch: "←/→ 切换请求 · ",
	helpCore: "↑/↓ 选择 · Enter 展开/折叠工具 · a 全部展开 · Esc 关闭",
	executingFallback: "执行中",
};

function getStrings(resolvedLang: string): UiStrings {
	return isChineseUiLanguage(resolvedLang) ? ZH_STRINGS : EN_STRINGS;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function stepIcon(step: IntentStep, theme: Theme): string {
	switch (step.status) {
		case "active":
			return theme.fg("accent", "▶");
		case "done":
			return theme.fg("success", "✓");
		case "rejected":
			return theme.fg("warning", "✗");
		case "aborted":
			return theme.fg("error", "■");
	}
}

function toolIcon(tool: ToolRecord, theme: Theme): string {
	switch (tool.status) {
		case "running":
			return theme.fg("accent", "⋯");
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
	}
}

function formatFileDelta(file: TouchedFile, theme: Theme): string {
	const countTag = file.editCount > 1 ? `×${file.editCount}` : "";
	const add = file.addedLines > 0 ? theme.fg("success", `+${file.addedLines}`) : "";
	const del = file.removedLines > 0 ? theme.fg("error", `-${file.removedLines}`) : "";
	const sep = add && del ? theme.fg("dim", "/") : "";
	const diff = add || del ? `${theme.fg("dim", "(")}${add}${sep}${del}${theme.fg("dim", ")")}` : "";
	return `${file.shortPath}${theme.fg("dim", countTag)}${diff}`;
}

function formatCompactTools(tools: ToolRecord[], s: UiStrings): string {
	if (tools.length === 0) return "";
	const running = tools.filter((t) => t.status === "running");
	const failed = tools.filter((t) => t.status === "error");
	const sample = running[0] ?? tools[tools.length - 1]!;
	const label = `${sample.toolName} ${sample.target}`;
	const extra = tools.length > 1 ? ` +${tools.length - 1}` : "";
	const errTag = failed.length > 0 ? ` · ${s.toolErrors(failed.length)}` : "";
	return `(${label}${extra}${errTag})`;
}

/** Soft-wrap plain text by character width for clean multi-line detail display inside overlays. */
export function wrapPlainText(text: string, maxWidth: number): string[] {
	const clean = text.replace(/\s+/g, " ").trim();
	if (!clean) return [];
	const limit = Math.max(16, maxWidth);
	if (visibleWidth(clean) <= limit) return [clean];

	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;

	// Split preserving spaces so English wraps on words while CJK wraps smoothly by character
	const tokens = clean.match(/(\s+|\S+)/g) ?? [clean];
	for (const token of tokens) {
		const tokWidth = visibleWidth(token);
		if (currentWidth === 0 && /^\s+$/.test(token)) continue;

		if (currentWidth + tokWidth <= limit) {
			current += token;
			currentWidth += tokWidth;
			continue;
		}

		if (currentWidth > 0) {
			lines.push(current.trimEnd());
			current = "";
			currentWidth = 0;
			if (/^\s+$/.test(token)) continue;
		}

		if (tokWidth <= limit) {
			current = token;
			currentWidth = tokWidth;
		} else {
			// Break long CJK runs or long identifiers cleanly
			for (const ch of token) {
				const chW = visibleWidth(ch);
				if (currentWidth + chW > limit && currentWidth > 0) {
					lines.push(current);
					current = ch;
					currentWidth = chW;
				} else {
					current += ch;
					currentWidth += chW;
				}
			}
		}
	}
	if (current.trim()) lines.push(current.trimEnd());
	return lines;
}

export function renderWidgetLines(
	state: IntentState,
	theme: Theme,
	width: number,
	spinnerIndex = 0,
	options: UiRenderOptions = { detail: "medium", resolvedLang: "en" },
): string[] {
	if (!state.goal && state.steps.length === 0) return [];

	const s = getStrings(options.resolvedLang);
	const detail = options.detail;
	const lines: string[] = [];

	const spin = state.isAnalyzing
		? ` ${theme.fg("accent", SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length]!)}`
		: "";
	const stepCount = state.steps.length > 0 ? s.stepsUnit(state.steps.length) : s.preparing;
	const histTag = state.history.length > 0 ? ` · ${s.historyUnit(state.history.length)}` : "";
	const detailTag = ` · ${detail}`;
	const stateTag = state.isRunning ? theme.fg("accent", s.running) : theme.fg("dim", s.done);
	const headerLeft = `${theme.fg("accent", "🧭")} ${theme.bold(state.goal || s.executingFallback)}${spin}`;
	const headerRight = theme.fg("dim", `[${stepCount}${histTag}${detailTag} · ${stateTag} · ${s.expandHint}]`);
	lines.push(truncateToWidth(`${headerLeft}  ${headerRight}`, width));

	const activeIdx = state.steps.findIndex((st) => st.status === "active");
	const currentIdx = activeIdx >= 0 ? activeIdx : state.steps.length - 1;
	const current = currentIdx >= 0 ? state.steps[currentIdx] : undefined;

	// Completed history steps shown above current step depend on granularity:
	// low: 0 previous steps | medium: 1 previous step | high: up to 2 previous steps
	const prevCount = detail === "low" ? 0 : detail === "high" ? 2 : 1;
	if (prevCount > 0 && currentIdx > 0) {
		const startIdx = Math.max(0, currentIdx - prevCount);
		for (let i = startIdx; i < currentIdx; i++) {
			const prev = state.steps[i]!;
			const phase = theme.fg("dim", `[${s.phases[prev.phase]}]`);
			const verdict = prev.verdict ? theme.fg("muted", ` → ${prev.verdict}`) : "";
			lines.push(
				truncateToWidth(`  ${stepIcon(prev, theme)} ${phase} ${theme.fg("muted", prev.intent)}${verdict}`, width),
			);
		}
	}

	if (current) {
		const phase = theme.fg("accent", `[${s.phases[current.phase]}]`);
		const verdict = current.verdict
			? theme.fg(current.status === "rejected" ? "warning" : "success", ` → ${current.verdict}`)
			: "";

		if (detail === "low") {
			const failedCount = current.tools.filter((t) => t.status === "error").length;
			const errBadge = failedCount > 0 ? `  ${theme.fg("error", `(${s.toolErrors(failedCount)})`)}` : "";
			lines.push(
				truncateToWidth(`  ${stepIcon(current, theme)} ${phase} ${current.intent}${verdict}${errBadge}`, width),
			);
		} else if (detail === "medium") {
			const hyp =
				current.status === "active" && current.hypothesis
					? theme.fg("dim", ` · ${s.hypLabel} ${current.hypothesis}`)
					: "";
			const toolsBadge =
				current.tools.length > 0 ? `  ${theme.fg("dim", formatCompactTools(current.tools, s))}` : "";
			lines.push(
				truncateToWidth(
					`  ${stepIcon(current, theme)} ${phase} ${current.intent}${hyp}${verdict}${toolsBadge}`,
					width,
				),
			);
		} else {
			// High detail: dedicated lines for hypothesis, evidence, and nextPlan
			const toolsBadge =
				current.tools.length > 0 ? `  ${theme.fg("dim", formatCompactTools(current.tools, s))}` : "";
			lines.push(
				truncateToWidth(`  ${stepIcon(current, theme)} ${phase} ${current.intent}${verdict}${toolsBadge}`, width),
			);
			if (current.hypothesis) {
				lines.push(
					truncateToWidth(
						`      ${theme.fg("dim", s.hypLabel)} ${theme.fg("muted", current.hypothesis)}`,
						width,
					),
				);
			}
			if (current.evidence) {
				lines.push(
					truncateToWidth(
						`      ${theme.fg("dim", s.evidLabel)} ${theme.fg("muted", current.evidence)}`,
						width,
					),
				);
			}
			if (current.status === "active" && current.nextPlan) {
				lines.push(
					truncateToWidth(
						`      ${theme.fg("dim", s.nextLabel)} ${theme.fg("dim", current.nextPlan)}`,
						width,
					),
				);
			}
		}
	} else if (state.isRunning) {
		lines.push(truncateToWidth(`  ${theme.fg("dim", s.waitingThinking)}`, width));
	}

	if (state.touchedFiles.length > 0) {
		if (detail === "low") {
			const latest = state.touchedFiles[state.touchedFiles.length - 1]!;
			const extra =
				state.touchedFiles.length > 1
					? theme.fg("dim", ` ${s.moreFiles(state.touchedFiles.length - 1)}`)
					: "";
			lines.push(
				truncateToWidth(
					`  ${theme.fg("accent", "✏")} ${theme.fg("dim", `${s.editedFilesHeader(state.touchedFiles.length)}:`)} ${formatFileDelta(latest, theme)}${extra}`,
					width,
				),
			);
		} else if (detail === "high") {
			const recentFiles = state.touchedFiles.slice(-2);
			for (let i = 0; i < recentFiles.length; i++) {
				const file = recentFiles[i]!;
				const prefix =
					i === 0
						? `  ${theme.fg("accent", "✏")} ${theme.fg("dim", `${s.editedFilesHeader(state.touchedFiles.length)}:`)} `
						: `      `;
				const why = file.lastNote ? ` ${theme.fg("muted", `— ${file.lastNote}`)}` : "";
				const extra =
					i === recentFiles.length - 1 && state.touchedFiles.length > 2
						? theme.fg("dim", ` ${s.moreFiles(state.touchedFiles.length - 2)}`)
						: "";
				lines.push(truncateToWidth(`${prefix}${formatFileDelta(file, theme)}${why}${extra}`, width));
			}
		} else {
			const latest = state.touchedFiles[state.touchedFiles.length - 1]!;
			const extra =
				state.touchedFiles.length > 1
					? theme.fg("dim", ` ${s.moreFiles(state.touchedFiles.length - 1)}`)
					: "";
			const why = latest.lastNote ? ` ${theme.fg("muted", `— ${latest.lastNote}`)}` : "";
			lines.push(
				truncateToWidth(
					`  ${theme.fg("accent", "✏")} ${theme.fg("dim", `${s.editedFilesHeader(state.touchedFiles.length)}:`)} ${formatFileDelta(latest, theme)}${why}${extra}`,
					width,
				),
			);
		}
	}

	if (state.warning) {
		lines.push(truncateToWidth(`  ${theme.fg("warning", `⚠ ${state.warning}`)}`, width));
	}

	return lines;
}

export class RioOverlayComponent {
	private readonly getState: () => IntentState;
	private readonly getStats: () => SidecarStats;
	private readonly getOptions: () => UiRenderOptions;
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly done: () => void;
	private topicCursor: number;
	private selectedIndex = 0;
	private expandedStepIds = new Set<number>();
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		getState: () => IntentState,
		getStats: () => SidecarStats,
		getOptions: () => UiRenderOptions,
		theme: Theme,
		requestRender: () => void,
		done: () => void,
	) {
		this.getState = getState;
		this.getStats = getStats;
		this.getOptions = getOptions;
		this.theme = theme;
		this.requestRender = requestRender;
		this.done = done;
		const state = this.getState();
		this.topicCursor = state.history.length;
		this.resetSelectionForActiveTopic();
	}

	private getViewedTopic(): {
		goal: string;
		steps: IntentStep[];
		touchedFiles: TouchedFile[];
		warning?: string;
		isArchived: boolean;
		topicIndex: number;
		totalTopics: number;
	} {
		const state = this.getState();
		const totalTopics = state.history.length + 1;
		const clamped = Math.max(0, Math.min(this.topicCursor, totalTopics - 1));
		this.topicCursor = clamped;

		if (clamped < state.history.length) {
			const archived = state.history[clamped]!;
			return {
				goal: archived.goal,
				steps: archived.steps,
				touchedFiles: archived.touchedFiles,
				isArchived: true,
				topicIndex: clamped,
				totalTopics,
			};
		}

		return {
			goal: state.goal,
			steps: state.steps,
			touchedFiles: state.touchedFiles,
			warning: state.warning,
			isArchived: false,
			topicIndex: clamped,
			totalTopics,
		};
	}

	private resetSelectionForActiveTopic(): void {
		const { steps } = this.getViewedTopic();
		const { detail } = this.getOptions();
		this.expandedStepIds.clear();
		this.scrollOffset = 0;
		if (steps.length > 0) {
			this.selectedIndex = steps.length - 1;
			if (detail !== "low") {
				this.expandedStepIds.add(steps[steps.length - 1]!.id);
			}
		} else {
			this.selectedIndex = 0;
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.done();
			return;
		}

		const topic = this.getViewedTopic();
		if (topic.totalTopics > 1) {
			if (matchesKey(data, "left") || data === "[" || data === "h") {
				if (this.topicCursor > 0) {
					this.topicCursor -= 1;
					this.resetSelectionForActiveTopic();
					this.invalidate();
					this.requestRender();
				}
				return;
			}
			if (matchesKey(data, "right") || data === "]" || data === "l") {
				if (this.topicCursor < topic.totalTopics - 1) {
					this.topicCursor += 1;
					this.resetSelectionForActiveTopic();
					this.invalidate();
					this.requestRender();
				}
				return;
			}
		}

		const count = topic.steps.length;
		if (count === 0) return;

		if (matchesKey(data, "up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.selectedIndex = Math.min(count - 1, this.selectedIndex + 1);
		} else if (matchesKey(data, "enter") || data === " ") {
			const step = topic.steps[this.selectedIndex];
			if (step) {
				if (this.expandedStepIds.has(step.id)) {
					this.expandedStepIds.delete(step.id);
				} else {
					this.expandedStepIds.add(step.id);
				}
			}
		} else if (data === "a" || data === "A") {
			if (this.expandedStepIds.size === count) {
				this.expandedStepIds.clear();
			} else {
				for (const st of topic.steps) this.expandedStepIds.add(st.id);
			}
		} else {
			return;
		}

		this.invalidate();
		this.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const topic = this.getViewedTopic();
		const stats = this.getStats();
		const opts = this.getOptions();
		const s = getStrings(opts.resolvedLang);
		const detail = opts.detail;

		const boxWidth = Math.max(44, width);
		const innerWidth = boxWidth - 2;

		const padRow = (content: string): string => {
			const trimmed = truncateToWidth(content, innerWidth);
			const vis = visibleWidth(trimmed);
			const pad = " ".repeat(Math.max(0, innerWidth - vis));
			return `${th.fg("border", "│")}${trimmed}${pad}${th.fg("border", "│")}`;
		};

		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(innerWidth)}╮`));

		const topicBadge =
			topic.totalTopics > 1
				? `  ${th.fg(topic.isArchived ? "warning" : "accent", s.topicBadge(topic.topicIndex + 1, topic.totalTopics, topic.isArchived))}`
				: "";
		const metaTag = th.fg(
			"dim",
			`[${detail} · ${opts.resolvedLang}${stats.activeModelLabel ? ` · ${stats.activeModelLabel}` : ""}]`,
		);
		const title = ` ${th.fg("accent", th.bold(s.overlayTitle))}${topicBadge}  ${metaTag}`;
		lines.push(padRow(title));
		lines.push(padRow(` ${th.fg("accent", "❓")} ${th.bold(topic.goal || s.noPromptYet)}`));

		if (topic.warning) {
			lines.push(padRow(` ${th.fg("warning", `${s.warningPrefix} ${topic.warning}`)}`));
		}

		if (topic.touchedFiles.length > 0) {
			const maxFiles = detail === "high" ? 14 : detail === "low" ? 5 : 8;
			lines.push(th.fg("border", `├${"─".repeat(innerWidth)}┤`));
			lines.push(
				padRow(
					` ${th.fg("accent", th.bold(`✏ ${s.editedFilesHeader(topic.touchedFiles.length)}`))} ${th.fg("dim", s.editedFilesSub)}`,
				),
			);
			for (const file of topic.touchedFiles.slice(-maxFiles)) {
				const tag = file.action === "written" ? th.fg("success", "A") : th.fg("warning", "M");
				const why = file.lastNote && detail !== "low" ? ` ${th.fg("muted", `— ${file.lastNote}`)}` : "";
				lines.push(padRow(`   ${tag} ${formatFileDelta(file, th)}${why}`));
			}
			if (topic.touchedFiles.length > maxFiles) {
				lines.push(padRow(`   ${th.fg("dim", s.moreEarlierFiles(topic.touchedFiles.length - maxFiles))}`));
			}
		}

		lines.push(th.fg("border", `├${"─".repeat(innerWidth)}┤`));

		const bodyLines: { text: string; stepIdx: number }[] = [];
		const pushLabeledField = (
			label: string,
			value: string,
			color: "muted" | "dim" | "success" | "warning",
			stepIdx: number,
		) => {
			const prefixIndent = "       ";
			const labelPrefix = `${prefixIndent}${label} `;
			const availableWidth = Math.max(20, innerWidth - visibleWidth(labelPrefix) - 1);
			const wrapped = detail === "high" ? wrapPlainText(value, availableWidth) : [value];
			for (let i = 0; i < wrapped.length; i++) {
				if (i === 0) {
					bodyLines.push({
						text: `${prefixIndent}${th.fg("dim", label)} ${th.fg(color, wrapped[i]!)}`,
						stepIdx,
					});
				} else {
					bodyLines.push({
						text: `${" ".repeat(visibleWidth(labelPrefix))}${th.fg(color, wrapped[i]!)}`,
						stepIdx,
					});
				}
			}
		};

		if (topic.steps.length === 0) {
			bodyLines.push({ text: ` ${th.fg("dim", s.emptyBody)}`, stepIdx: -1 });
		} else {
			this.selectedIndex = Math.min(this.selectedIndex, topic.steps.length - 1);
			topic.steps.forEach((step, idx) => {
				const selected = idx === this.selectedIndex;
				const expanded = this.expandedStepIds.has(step.id);
				const pointer = selected ? th.fg("accent", "›") : " ";
				const expandGlyph = step.tools.length > 0 ? (expanded ? "▾" : "▸") : "·";
				const phase = th.fg(step.status === "active" ? "accent" : "dim", `[${s.phases[step.phase]}]`);
				const toolCount = step.tools.length > 0 ? th.fg("dim", ` ${s.toolsCount(step.tools.length)}`) : "";
				const intentText = selected ? th.bold(step.intent) : step.intent;

				bodyLines.push({
					text: ` ${pointer} ${th.fg("dim", expandGlyph)} ${stepIcon(step, th)} ${th.fg("dim", `${step.id}.`)} ${phase} ${intentText}${toolCount}`,
					stepIdx: idx,
				});

				if (detail !== "low" && step.hypothesis) {
					pushLabeledField(s.hypLabel, step.hypothesis, "muted", idx);
				}
				if (detail === "high" && step.evidence) {
					pushLabeledField(s.evidLabel, step.evidence, "muted", idx);
				}
				if (detail === "high" && step.nextPlan && step.status === "active") {
					pushLabeledField(s.nextLabel, step.nextPlan, "dim", idx);
				}
				if (step.verdict) {
					const verdictColor = step.status === "rejected" ? "warning" : "success";
					pushLabeledField(s.verdictLabel, step.verdict, verdictColor, idx);
				}

				if (expanded && step.tools.length > 0) {
					for (const tool of step.tools) {
						const dur = tool.durationMs !== undefined ? th.fg("dim", ` ${tool.durationMs}ms`) : "";
						const err = tool.errorSnippet ? th.fg("error", ` · ${tool.errorSnippet}`) : "";
						bodyLines.push({
							text: `       ${th.fg("dim", "└─")} ${toolIcon(tool, th)} ${th.fg("muted", tool.toolName)} ${th.fg("dim", tool.target)}${dur}${err}`,
							stepIdx: idx,
						});
					}
				}
			});
		}

		const maxBodyHeight = detail === "high" ? 24 : 20;
		const selectedLineIdx = bodyLines.findIndex((b) => b.stepIdx === this.selectedIndex);
		if (selectedLineIdx >= 0) {
			if (selectedLineIdx < this.scrollOffset) {
				this.scrollOffset = selectedLineIdx;
			} else if (selectedLineIdx >= this.scrollOffset + maxBodyHeight) {
				this.scrollOffset = selectedLineIdx - maxBodyHeight + 1;
			}
		}
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, bodyLines.length - maxBodyHeight)));

		const visibleBody = bodyLines.slice(this.scrollOffset, this.scrollOffset + maxBodyHeight);
		for (const row of visibleBody) {
			lines.push(padRow(row.text));
		}

		lines.push(th.fg("border", `├${"─".repeat(innerWidth)}┤`));

		const costStr = `$${stats.totalCost.toFixed(5)}`;
		const latStr = stats.avgLatencyMs ? `${Math.round(stats.avgLatencyMs)}ms` : "-";
		lines.push(
			padRow(` ${th.fg("dim", s.statsLine(stats.calls, stats.inputTokens, stats.outputTokens, costStr, latStr))}`),
		);

		if (stats.lastError) {
			lines.push(padRow(` ${th.fg("error", `${s.lastErrorPrefix} ${stats.lastError}`)}`));
		}

		const switchHint = topic.totalTopics > 1 ? s.helpSwitch : "";
		lines.push(padRow(` ${th.fg("dim", `${switchHint}${s.helpCore}`)}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerWidth)}╯`));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
