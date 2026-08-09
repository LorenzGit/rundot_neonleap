export type InterstitialGateReason =
    | "eligible"
    | "disabled"
    | "rewarded-interaction"
    | "entitlements-unverified"
    | "ad-free"
    | "first-session"
    | "progression"
    | "frequency"
    | "trusted-time"
    | "session-cap"
    | "daily-cap"
    | "cooldown"
    | "host-unavailable"
    | "no-fill"
    | "already-evaluated"
    | "in-flight";

export interface InterstitialGateInput {
    controlsEnabled: boolean;
    rewardedInteracted: boolean;
    entitlementsVerified: boolean;
    adFree: boolean;
    minCompletedSessions: number;
    minProgression: number;
    completedRunsAtSessionStart: number;
    totalRuns: number;
    progression: number;
    everyNthRun: number;
    trustedTimeReady: boolean;
    shownThisSession: number;
    sessionCap: number;
    shownToday: number;
    dailyCap: number;
    sinceLastShownMs: number;
    cooldownMs: number;
    hostReady: boolean;
    adReady: boolean;
    alreadyEvaluated: boolean;
    inFlight: boolean;
}

export function evaluateInterstitialGate(input: InterstitialGateInput): InterstitialGateReason {
    if (!input.controlsEnabled) return "disabled";
    if (input.rewardedInteracted) return "rewarded-interaction";
    if (!input.entitlementsVerified) return "entitlements-unverified";
    if (input.adFree) return "ad-free";
    if (input.completedRunsAtSessionStart < input.minCompletedSessions) return "first-session";
    if (input.progression < input.minProgression) return "progression";
    if (input.totalRuns < input.everyNthRun || input.totalRuns % input.everyNthRun !== 0) return "frequency";
    if (!input.trustedTimeReady) return "trusted-time";
    if (input.shownThisSession >= input.sessionCap) return "session-cap";
    if (input.shownToday >= input.dailyCap) return "daily-cap";
    if (input.sinceLastShownMs < input.cooldownMs) return "cooldown";
    if (!input.hostReady) return "host-unavailable";
    if (input.inFlight) return "in-flight";
    if (input.alreadyEvaluated) return "already-evaluated";
    if (!input.adReady) return "no-fill";
    return "eligible";
}
