import type { DetailLevel, IntentState, TurnDelta } from "./types.ts";

export interface DetailProfile {
	level: DetailLevel;
	thinkingHeadChars: number;
	thinkingTailChars: number;
	assistantTextChars: number;
	maxRecentSteps: number;
	maxToolCalls: number;
	maxOutcomes: number;
	outcomeSnippetChars: number;
	maxTokens: number;
	limits: {
		intent: number;
		hypothesis: number;
		evidence: number;
		nextPlan: number;
		verdict: number;
		changeNote: number;
		fileWhy: number;
		warning: number;
	};
}

export const DETAIL_PROFILES: Record<DetailLevel, DetailProfile> = {
	low: {
		level: "low",
		thinkingHeadChars: 350,
		thinkingTailChars: 350,
		assistantTextChars: 180,
		maxRecentSteps: 4,
		maxToolCalls: 6,
		maxOutcomes: 4,
		outcomeSnippetChars: 80,
		maxTokens: 768,
		limits: {
			intent: 72,
			hypothesis: 72,
			evidence: 80,
			nextPlan: 72,
			verdict: 84,
			changeNote: 64,
			fileWhy: 64,
			warning: 80,
		},
	},
	medium: {
		level: "medium",
		thinkingHeadChars: 650,
		thinkingTailChars: 650,
		assistantTextChars: 300,
		maxRecentSteps: 6,
		maxToolCalls: 10,
		maxOutcomes: 6,
		outcomeSnippetChars: 130,
		maxTokens: 1536,
		limits: {
			intent: 100,
			hypothesis: 110,
			evidence: 120,
			nextPlan: 100,
			verdict: 120,
			changeNote: 96,
			fileWhy: 96,
			warning: 100,
		},
	},
	high: {
		level: "high",
		thinkingHeadChars: 1400,
		thinkingTailChars: 1400,
		assistantTextChars: 600,
		maxRecentSteps: 10,
		maxToolCalls: 16,
		maxOutcomes: 10,
		outcomeSnippetChars: 240,
		maxTokens: 2560,
		limits: {
			intent: 140,
			hypothesis: 160,
			evidence: 180,
			nextPlan: 150,
			verdict: 180,
			changeNote: 130,
			fileWhy: 140,
			warning: 130,
		},
	},
};

export function normalizeDetailLevel(raw: unknown, fallback: DetailLevel = "medium"): DetailLevel {
	if (typeof raw !== "string") return fallback;
	const lower = raw.trim().toLowerCase();
	if (lower === "low" || lower === "medium" || lower === "high") return lower;
	if (lower === "l" || lower === "min" || lower === "minimal") return "low";
	if (lower === "m" || lower === "med" || lower === "normal" || lower === "default") return "medium";
	if (lower === "h" || lower === "max" || lower === "verbose" || lower === "detailed") return "high";
	return fallback;
}

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
	en: "English",
	zh: "Simplified Chinese (简体中文)",
	"zh-tw": "Traditional Chinese (繁體中文)",
	ja: "Japanese (日本語)",
	ko: "Korean (한국어)",
	es: "Spanish (Español)",
	fr: "French (Français)",
	de: "German (Deutsch)",
	pt: "Portuguese (Português)",
	ru: "Russian (Русский)",
};

export function resolveOutputLanguage(configured: string, env: NodeJS.ProcessEnv = process.env): string {
	const raw = configured.trim();
	if (!raw || raw.toLowerCase() === "auto") {
		const candidates = [env.LC_ALL, env.LANG].filter((v): v is string => Boolean(v && v.trim()));
		for (const locale of candidates) {
			const lower = locale.toLowerCase();
			if (lower.startsWith("zh_tw") || lower.startsWith("zh-tw") || lower.startsWith("zh_hk")) return "zh-tw";
			if (lower.startsWith("zh")) return "zh";
			if (lower.startsWith("ja")) return "ja";
			if (lower.startsWith("ko")) return "ko";
			if (lower.startsWith("en")) return "en";
		}
		return "en";
	}
	const lower = raw.toLowerCase();
	if (lower === "english") return "en";
	if (lower === "chinese" || lower === "zh-cn" || lower === "zh_cn") return "zh";
	if (lower === "zh_tw") return "zh-tw";
	return lower;
}

export function isChineseUiLanguage(resolvedLang: string): boolean {
	return resolvedLang === "zh" || resolvedLang === "zh-tw" || resolvedLang.startsWith("zh-");
}

function formatLanguageDirective(resolvedLang: string): string {
	const display = LANGUAGE_DISPLAY_NAMES[resolvedLang] ?? resolvedLang;
	return `Output language: write ALL human-readable JSON string values in ${display}. Keep JSON keys and enum values ("op", "phase", "prevOutcome") in exact English lowercase.`;
}

function buildLowSystemPrompt(resolvedLang: string): string {
	const isZh = isChineseUiLanguage(resolvedLang);
	const lengthRule = isZh
		? "Ultra-brief Chinese phrases: <= 16 chars per field."
		: "Ultra-brief phrases: <= 10 words per field.";
	const badGood = isZh
		? 'Bad: "读取 auth.ts 和 middleware.ts" | Good: "定位 401 抛出位置"'
		: 'Bad: "Read auth.ts and middleware.ts" | Good: "Locate where 401 is thrown"';

	return [
		"You are pi-rio (LOW detail mode), an executive radar sidecar for a coding agent.",
		"The human wants a high-level milestone ticker with minimal noise—only major phase shifts, pivots, and final verdicts.",
		formatLanguageDirective(resolvedLang),
		"",
		"Rules:",
		"1. Output ONLY a single valid JSON object. No markdown fences, no commentary.",
		`2. ${lengthRule}`,
		`3. NEVER parrot tool names or file lists as the intent. ${badGood}`,
		"4. Prefer op=\"keep\" aggressively while the agent stays in the same high-level milestone. Only push/resolve on clear milestone shifts or real pivots.",
		"5. op values:",
		"   - keep: still working within the current milestone.",
		"   - push: no steps yet, or starting the first real milestone.",
		'   - resolve_and_push: previous milestone finished; move to next (set prevVerdict, prevOutcome="done").',
		'   - pivot: previous direction failed or was disproven; changing course (set prevVerdict, prevOutcome="rejected").',
		"   - done: agent is answering the user with no further tools; MUST set prevVerdict with a crisp final outcome.",
		"6. Omit hypothesis, evidence, and nextPlan in low detail mode unless truly critical.",
		"7. If this turn calls edit/write, include fileChanges with a short why per file.",
		"8. If stuck repeating similar errors/searches across turns, set a brief warning; clear with warning: null once unstuck.",
		"",
		"JSON schema:",
		'{"op":"keep|push|resolve_and_push|pivot|done","phase":"explore|plan|edit|verify|debug|done","prevVerdict":"required on resolve_and_push/pivot/done","prevOutcome":"done|rejected","intent":"high-level milestone","changeNote":"optional 1-line edit summary","fileChanges":[{"path":"file","why":"why edited"}],"warning":"optional alert or null"}',
	].join("\n");
}

function buildMediumSystemPrompt(resolvedLang: string): string {
	const isZh = isChineseUiLanguage(resolvedLang);
	const lengthRule = isZh
		? "Concise Chinese short sentences: <= 24 chars per field."
		: "Concise phrases: <= 16 words per field.";
	const badGood = isZh
		? 'Bad: "读取 auth.ts 和 middleware.ts" | Good: "确认 token 过期判断写在哪里"'
		: 'Bad: "Read auth.ts and middleware.ts" | Good: "Verify where token expiry is checked"';

	return [
		"You are pi-rio (MEDIUM detail mode), a live Radar Intercept Officer (RIO) sidecar for a coding agent.",
		"The human does not want a list of files read. They want to know WHY the agent is taking this step, WHAT hypothesis it is testing, WHAT the last step concluded, and whether it pivoted or got stuck.",
		formatLanguageDirective(resolvedLang),
		"",
		"Rules:",
		"1. Output ONLY a single valid JSON object. No markdown fences, no commentary.",
		`2. ${lengthRule}`,
		`3. NEVER repeat tool names as the intent. ${badGood}`,
		"4. op values:",
		"   - keep: continuing the current intent (e.g. reading related files for the same question) with no new hypothesis or pivot.",
		"   - push: no steps yet, or opening the first substantive step.",
		'   - resolve_and_push: previous step reached a conclusion and naturally advances (set prevVerdict, prevOutcome="done").',
		'   - pivot: previous hypothesis was disproven or blocked by an error; switching direction (set prevVerdict, prevOutcome="rejected").',
		"   - done: no more tool calls this turn / wrapping up to reply to the user. MUST set prevVerdict summarizing the final result.",
		"5. Include hypothesis whenever the agent is testing a concrete theory or root cause.",
		"6. If this turn calls edit/write, MUST include fileChanges (path + why each file is changed).",
		"7. If repeating similar searches or errors without progress, set warning; clear with warning: null once recovered.",
		"",
		"JSON schema:",
		'{"op":"keep|push|resolve_and_push|pivot|done","phase":"explore|plan|edit|verify|debug|done","prevVerdict":"required on resolve_and_push/pivot/done","prevOutcome":"done|rejected","intent":"core why of this step","hypothesis":"optional active hypothesis","changeNote":"optional 1-line edit summary","fileChanges":[{"path":"file","why":"why edited"}],"warning":"optional alert or null"}',
	].join("\n");
}

function buildHighSystemPrompt(resolvedLang: string): string {
	const isZh = isChineseUiLanguage(resolvedLang);
	const lengthRule = isZh
		? "Information-dense Chinese: 18-55 chars per field. Name specific functions, symbols, flags, or error causes when present."
		: "Information-dense prose: 12-30 words per field. Name specific symbols, functions, conditions, or error causes when present.";
	const badGood = isZh
		? 'Bad: "检查缓存逻辑" | Good: "核对 RedisSessionStore.save() 是否在覆盖 key 后漏掉 EXPIRE 续期"'
		: 'Bad: "Check cache logic" | Good: "Check whether RedisSessionStore.save() overwrites the key without refreshing TTL via EXPIRE"';

	return [
		"You are pi-rio (HIGH detail mode), a deep flight-recorder sidecar for a coding agent.",
		"The human wants full engineering visibility: exact reasoning, concrete evidence from code or errors, specific symbols/paths, rejected alternatives, per-file edit rationale, and the anticipated next move.",
		formatLanguageDirective(resolvedLang),
		"",
		"Rules:",
		"1. Output ONLY a single valid JSON object. No markdown fences, no commentary.",
		`2. ${lengthRule}`,
		`3. NEVER parrot generic tool calls. Always include concrete technical specifics. ${badGood}`,
		"4. Prefer splitting distinct sub-investigations or verification checks into separate steps (resolve_and_push / pivot) so the full decision tree is traceable. Use keep only when continuing the exact same sub-question.",
		"5. op values:",
		"   - keep: continuing the exact same sub-investigation; still update evidence/hypothesis/nextPlan if new facts emerged.",
		"   - push: no steps yet, or opening the first concrete investigation.",
		'   - resolve_and_push: previous step yielded a clear finding; advance to the next step (MUST set detailed prevVerdict citing what was found, prevOutcome="done").',
		'   - pivot: previous hypothesis was disproven, an assumption failed, or a blocker forced a new angle (MUST explain WHY in prevVerdict, prevOutcome="rejected").',
		"   - done: agent is finishing and replying to the user. MUST set prevVerdict summarizing the root cause/changes and verification outcome.",
		"6. Actively populate these rich fields when supported by the turn:",
		"   - hypothesis: the specific technical assumption or root-cause theory being tested.",
		"   - evidence: concrete signal observed from previous tool outputs or thinking (e.g. exact error message, symbol behavior, failing assertion, line/file finding).",
		"   - nextPlan: what the agent plans to do next if this check confirms or refutes the hypothesis.",
		"7. If this turn calls edit/write, MUST include fileChanges explaining the exact behavioral change and why for each file.",
		"8. Detect loops, thrashing, or repeated failing commands and surface a specific warning; clear with warning: null once unstuck.",
		"",
		"JSON schema:",
		'{"op":"keep|push|resolve_and_push|pivot|done","phase":"explore|plan|edit|verify|debug|done","prevVerdict":"detailed conclusion citing concrete findings","prevOutcome":"done|rejected","intent":"specific engineering intent naming symbols/components","hypothesis":"specific technical hypothesis being tested","evidence":"concrete finding/signal observed from code, logs, or errors","nextPlan":"anticipated next move or fallback branch","changeNote":"concise summary of code change","fileChanges":[{"path":"file","why":"exact behavioral change and why"}],"warning":"specific loop/blocker alert or null"}',
	].join("\n");
}

export function getSidecarSystemPrompt(detail: DetailLevel, resolvedLang: string): string {
	switch (detail) {
		case "low":
			return buildLowSystemPrompt(resolvedLang);
		case "high":
			return buildHighSystemPrompt(resolvedLang);
		case "medium":
		default:
			return buildMediumSystemPrompt(resolvedLang);
	}
}

export function truncateHeadTail(text: string, headChars: number, tailChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= headChars + tailChars + 24) return trimmed;
	const omitted = trimmed.length - headChars - tailChars;
	return `${trimmed.slice(0, headChars).trim()}\n...[omitted ${omitted} chars]...\n${trimmed.slice(-tailChars).trim()}`;
}

function compactText(value: string | undefined, maxLen: number): string {
	if (!value) return "";
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLen) return singleLine;
	return `${singleLine.slice(0, Math.max(1, maxLen - 1))}…`;
}

export function serializeStateForPrompt(state: IntentState, maxSteps = 6, includeHighFields = false): string {
	const recent = state.steps.slice(-maxSteps);
	const lines: string[] = [`Current user request (Root): ${state.rawPrompt || state.goal || "(unset)"}`];
	const prevTopic = state.history[state.history.length - 1];
	if (prevTopic) {
		const lastStep = prevTopic.steps[prevTopic.steps.length - 1];
		const prevSummary = lastStep?.verdict ? ` (${lastStep.verdict})` : "";
		lines.push(`Previous request context: ${prevTopic.goal}${prevSummary}`);
	}
	if (state.warning) {
		lines.push(`Active warning: ${state.warning}`);
	}
	if (recent.length === 0) {
		lines.push("Existing steps: (none)");
	} else {
		lines.push("Existing steps:");
		for (const step of recent) {
			const statusTag =
				step.status === "active"
					? step.isPlaceholder
						? "placeholder"
						: "active"
					: step.status;
			const hyp = step.hypothesis ? ` | hyp: ${step.hypothesis}` : "";
			const ev = includeHighFields && step.evidence ? ` | evidence: ${step.evidence}` : "";
			const verdict = step.verdict ? ` | verdict: ${step.verdict}` : "";
			const toolCount = step.tools.length > 0 ? ` (${step.tools.length} tools)` : "";
			lines.push(`- #${step.id} [${step.phase}/${statusTag}] ${step.intent}${hyp}${ev}${verdict}${toolCount}`);
		}
	}
	if (state.touchedFiles.length > 0) {
		const filesText = state.touchedFiles
			.slice(-8)
			.map((f) => `${f.shortPath}(+${f.addedLines}/-${f.removedLines})`)
			.join(", ");
		lines.push(`Edited files: ${filesText}`);
	}
	return lines.join("\n");
}

export function buildSidecarUserPrompt(
	state: IntentState,
	delta: TurnDelta,
	detail: DetailLevel = "medium",
): string {
	const profile = DETAIL_PROFILES[detail];
	const sections: string[] = [];

	sections.push("## Current Reasoning Trail");
	sections.push(serializeStateForPrompt(state, profile.maxRecentSteps, detail === "high"));

	if (delta.previousOutcomes.length > 0) {
		sections.push("");
		sections.push("## Previous Turn Tool Outcomes");
		for (const outcome of delta.previousOutcomes.slice(0, profile.maxOutcomes)) {
			const status = outcome.isError ? "ERROR" : "OK";
			const snippet = outcome.snippet ? ` -> ${compactText(outcome.snippet, profile.outcomeSnippetChars)}` : "";
			sections.push(`- [${status}] ${outcome.toolName}(${outcome.target})${snippet}`);
		}
	}

	sections.push("");
	sections.push(`## Current Turn (#${delta.turnIndex}) Delta`);

	if (delta.thinking.trim()) {
		sections.push("### Agent Thinking");
		sections.push(truncateHeadTail(delta.thinking, profile.thinkingHeadChars, profile.thinkingTailChars));
	} else {
		sections.push("### Agent Thinking\n(No explicit thinking block; infer intent from context and tool arguments.)");
	}

	if (delta.assistantText.trim()) {
		sections.push("### Agent Assistant Output");
		sections.push(compactText(delta.assistantText, profile.assistantTextChars));
	}

	if (delta.toolCalls.length > 0) {
		sections.push("### Planned Tool Calls");
		for (const tc of delta.toolCalls.slice(0, profile.maxToolCalls)) {
			const detailText = tc.detail ? ` | diff: ${tc.detail}` : "";
			sections.push(`- ${tc.toolName}: ${tc.target}${detailText}`);
		}
		if (delta.toolCalls.length > profile.maxToolCalls) {
			sections.push(`- ... and ${delta.toolCalls.length - profile.maxToolCalls} more tool calls`);
		}
	} else {
		sections.push("### Planned Tool Calls\n(None — replying directly to the user)");
	}

	sections.push("");
	sections.push("Return ONLY the raw JSON IntentPatch object:");
	return sections.join("\n");
}
