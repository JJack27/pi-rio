import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cloneSnapshot } from "./state.ts";
import type { DetailLevel, IntentState, SidecarStats } from "./types.ts";

export const LIVE_DIR = join(homedir(), ".pi", "agent", "rio-live");
const STALE_DEAD_MS = 24 * 60 * 60 * 1000;

export interface LiveSessionPayload {
	version: 1;
	sessionId: string;
	cwd: string;
	projectName: string;
	pid: number;
	detail: DetailLevel;
	language: string;
	orcaWorktreeId?: string;
	orcaPaneKey?: string;
	orcaTabId?: string;
	alive: boolean;
	updatedAt: number;
	stats: SidecarStats;
	state: IntentState;
}

function sanitizeFileName(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || `pid-${process.pid}`;
}

export function getLiveFilePath(sessionId: string): string {
	return join(LIVE_DIR, `${sanitizeFileName(sessionId)}.json`);
}

export function publishLiveSession(params: {
	sessionId: string;
	cwd: string;
	alive: boolean;
	detail: DetailLevel;
	language: string;
	stats: SidecarStats;
	state: IntentState;
}): void {
	try {
		mkdirSync(LIVE_DIR, { recursive: true });
		const snapshot = cloneSnapshot(params.state);
		// Preserve live running/analyzing flags for external viewers
		snapshot.isRunning = params.alive ? params.state.isRunning : false;
		snapshot.isAnalyzing = params.alive ? params.state.isAnalyzing : false;

		const payload: LiveSessionPayload = {
			version: 1,
			sessionId: params.sessionId,
			cwd: params.cwd,
			projectName: basename(params.cwd) || params.cwd,
			pid: process.pid,
			detail: params.detail,
			language: params.language,
			orcaWorktreeId: process.env.ORCA_WORKTREE_ID || undefined,
			orcaPaneKey: process.env.ORCA_PANE_KEY || undefined,
			orcaTabId: process.env.ORCA_TAB_ID || undefined,
			alive: params.alive,
			updatedAt: Date.now(),
			stats: { ...params.stats },
			state: snapshot,
		};

		const target = getLiveFilePath(params.sessionId);
		const tmp = `${target}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload), "utf8");
		renameSync(tmp, target);
	} catch {
		// Best-effort live sync; never interrupt Pi
	}
}

export function pruneStaleLiveFiles(now = Date.now()): void {
	try {
		mkdirSync(LIVE_DIR, { recursive: true });
		for (const name of readdirSync(LIVE_DIR)) {
			if (!name.endsWith(".json")) continue;
			const full = join(LIVE_DIR, name);
			try {
				const st = statSync(full);
				if (now - st.mtimeMs > STALE_DEAD_MS) {
					unlinkSync(full);
				}
			} catch {
				// Ignore individual file errors
			}
		}
	} catch {
		// Ignore directory errors
	}
}
