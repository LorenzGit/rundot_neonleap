// Distance leaderboard (RUN boards `default_alltime` / `default_daily`).
//
// The board is score-ordered "highest" and keeps the best, so the game submits
// DISTANCE — the number the whole design points at ("how far can you get") and
// the one the menu already calls BEST.
//
// Two server rules shape the submit policy, and both are honoured client-side
// so the player never sees a rejection they can do nothing about:
//
//   * runs shorter than MIN_DURATION_SECONDS are refused outright, and
//   * submissions are rate limited to one per RATE_LIMIT_SECONDS.
//
// So a run only goes up when it beats the player's own banked best, which is
// the only run whose ranking can change anything, and the sender backs off
// quietly when the limiter would reject it anyway.

import {
    createScoreToken,
    fetchLeaderboardScores,
    fetchMyLeaderboardRank,
    getRunCapabilities,
    recordAnalytics,
    submitLeaderboardScore,
} from "../sdk/runSdk.ts";
import { analytics } from "./analytics/analyticsConfig.ts";
import { saveSystem } from "./save.ts";

/** Mirrors the board config; a shorter run is rejected server-side. */
const MIN_DURATION_SECONDS = 10;
/** Mirrors `antiCheat.minTimeBetweenSubmissionsSec`. */
const RATE_LIMIT_SECONDS = 60;

export type LeaderboardPeriod = "alltime" | "daily";

export interface LeaderboardRow {
    rank: number | null;
    name: string;
    distance: number;
    isYou: boolean;
}

export interface LeaderboardView {
    /** False when the host cannot serve boards at all (local dev, mock host). */
    available: boolean;
    loading: boolean;
    period: LeaderboardPeriod;
    rows: LeaderboardRow[];
    myRank: number | null;
    totalPlayers: number;
    /** Player-facing explanation whenever `rows` is empty. */
    message: string;
}

let token: string | null = null;
let tokenRunKey = -1;
let lastSubmitAtMs = 0;
let lastResultRank: number | null = null;

export function leaderboardAvailable(): boolean {
    const capabilities = getRunCapabilities();
    return capabilities.leaderboard && !capabilities.mock;
}

/**
 * Mints a score token for the run about to start. Fire-and-forget: a missing
 * token never blocks play, and the board accepts an untokened submit.
 */
export function beginLeaderboardRun(runKey: number): void {
    token = null;
    tokenRunKey = runKey;
    if (!leaderboardAvailable()) return;
    void createScoreToken("default").then((minted) => {
        // A token that arrived after the run it belongs to already ended is
        // useless — and worse, would mislabel the NEXT run's duration.
        if (minted && tokenRunKey === runKey) token = minted.token;
    });
}

export interface RunScore {
    distance: number;
    durationSeconds: number;
    score: number;
    cells: number;
    tier: number;
}

export type SubmitOutcome =
    | { status: "submitted"; rank: number | null }
    | { status: "skipped"; reason: "unavailable" | "too-short" | "not-a-best" | "rate-limited" }
    | { status: "failed" };

/**
 * Sends a finished run if it is worth sending. Called after the run is banked,
 * so `records.bestDistance` already includes it.
 */
export async function submitRun(run: RunScore): Promise<SubmitOutcome> {
    if (!leaderboardAvailable()) return { status: "skipped", reason: "unavailable" };
    if (run.durationSeconds < MIN_DURATION_SECONDS) return { status: "skipped", reason: "too-short" };
    // Only a personal best can improve a keep-best ranking.
    if (run.distance < saveSystem.get().records.bestDistance) return { status: "skipped", reason: "not-a-best" };
    const sinceLast = (Date.now() - lastSubmitAtMs) / 1000;
    if (lastSubmitAtMs > 0 && sinceLast < RATE_LIMIT_SECONDS) return { status: "skipped", reason: "rate-limited" };

    const result = await submitLeaderboardScore({
        ...(token ? { token } : {}),
        score: run.distance,
        duration: Math.round(run.durationSeconds),
        mode: "default",
        metadata: { score: run.score, cells: run.cells, tier: run.tier },
    });
    token = null;
    if (!result) return { status: "failed" };
    lastSubmitAtMs = Date.now();
    lastResultRank = result.rank ?? null;
    recordAnalytics("leaderboard_submitted", {
        distance: run.distance,
        accepted: result.accepted,
        rank: result.rank ?? null,
        reason: result.reason ?? null,
    });
    if (result.accepted && result.rank !== null && result.rank !== undefined) {
        analytics.event("milestone_reached", { milestone: "leaderboard_rank", value: result.rank });
    }
    return { status: "submitted", rank: result.rank ?? null };
}

/** The rank the last accepted submission landed at, for the results screen. */
export function lastSubmittedRank(): number | null {
    return lastResultRank;
}

export async function loadLeaderboard(period: LeaderboardPeriod): Promise<LeaderboardView> {
    const base: LeaderboardView = {
        available: leaderboardAvailable(),
        loading: false,
        period,
        rows: [],
        myRank: null,
        totalPlayers: 0,
        message: "",
    };
    if (!base.available) {
        return { ...base, message: "LEADERBOARD NEEDS THE RUN APP — PLAY THERE TO RANK" };
    }
    recordAnalytics("leaderboard_viewed", { period });
    const [scores, mine] = await Promise.all([
        fetchLeaderboardScores({ mode: "default", period, limit: 20 }),
        fetchMyLeaderboardRank({ mode: "default", period }),
    ]);
    if (!scores) return { ...base, message: "LEADERBOARD UNREACHABLE — TRY AGAIN IN A MOMENT" };

    const myRank = mine?.rank ?? scores.playerRank ?? null;
    const rows: LeaderboardRow[] = scores.entries.map((entry) => ({
        rank: entry.rank,
        name: entry.username || "RUNNER",
        distance: Math.round(entry.score),
        isYou: myRank !== null && entry.rank === myRank,
    }));
    return {
        ...base,
        rows,
        myRank,
        totalPlayers: mine?.totalPlayers ?? scores.totalEntries,
        message: rows.length === 0 ? "NO RUNS BANKED YET — SET THE FIRST MARK" : "",
    };
}
