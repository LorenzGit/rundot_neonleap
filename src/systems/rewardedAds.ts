import { getRunCapabilities, isRewardedAdReady, recordAnalytics, showRewardedAd } from "../sdk/runSdk.ts";
import { monetizationPlacements } from "./monetization/config.ts";
import type { RewardedPlacement } from "./monetization/placementRegistry.ts";
import { getMonetizationRuntime } from "./monetization/runtime.ts";
import { saveSystem } from "./save.ts";
import { serverNow, trustedTimeGate } from "./serverTime.ts";

import { analytics } from "./analytics/analyticsConfig.ts";
const SECOND_WIND_PLACEMENT_ID = "rewarded_second_wind";
const registeredPlacement = monetizationPlacements.require(SECOND_WIND_PLACEMENT_ID);
if (registeredPlacement.type !== "rewarded") {
    throw new Error(`${SECOND_WIND_PLACEMENT_ID} must be a rewarded placement`);
}
const placement: RewardedPlacement = registeredPlacement;

export interface SecondWindView {
    visible: boolean;
    enabled: boolean;
    claimed: boolean;
    status: string;
    action: string;
}

export interface RewardedAdOutcome {
    granted: boolean;
    message: string;
}

export interface RewardedAdDiagnostics {
    ready: boolean;
    testReady: boolean;
}

let completedRunsAtSessionStart = 0;
let completedThisSession = 0;
let rewardedReady: boolean | null = null;
let requestInFlight = false;
/** One revive per run: keyed by the run counter the death belongs to. */
let currentRunKey = 0;

export function initializeRewardedAdsSession(): void {
    completedRunsAtSessionStart = saveSystem.get().records.totalRuns;
    completedThisSession = 0;
    rewardedReady = null;
    requestInFlight = false;
    currentRunKey = 0;
}

export function beginSecondWindRun(runKey: number): void {
    currentRunKey = runKey;
}

function claimId(): string {
    return `second-wind:${saveSystem.get().records.totalRuns}:${currentRunKey}`;
}

function dailyCompleted(day: string): number {
    const saved = saveSystem.get().monetization.rewardedAds;
    return saved.day === day ? saved.completedToday : 0;
}

function placementControls(): {
    enabled: boolean;
    sessionCap: number;
    dailyCap: number;
    cooldownSeconds: number;
} {
    const runtime = getMonetizationRuntime().controls;
    const remote = runtime.placements[SECOND_WIND_PLACEMENT_ID];
    return {
        enabled: runtime.enabled && runtime.rewardedAdsEnabled && remote?.enabled === true,
        sessionCap: Math.min(placement.sessionCap, remote?.sessionCap ?? 0),
        dailyCap: Math.min(placement.dailyCap, remote?.dailyCap ?? 0),
        cooldownSeconds: Math.max(placement.cooldownSeconds, remote?.cooldownSeconds ?? placement.cooldownSeconds),
    };
}

const HIDDEN: SecondWindView = { visible: false, enabled: false, claimed: false, status: "", action: "" };

export function secondWindView(revivesUsedThisRun: number): SecondWindView {
    const saved = saveSystem.get();
    const gate = trustedTimeGate();
    const controls = placementControls();

    if (saved.monetization.rewardedAds.claimIds.includes(claimId()) || revivesUsedThisRun > 0) {
        return { visible: true, enabled: false, claimed: true, status: "SECOND WIND SPENT", action: "ALREADY USED" };
    }
    if (completedRunsAtSessionStart < placement.unlock.minCompletedSessions) return HIDDEN;
    // NEONLEAP progression = best distance in metres (plan minProgression).
    if (saved.records.bestDistance < placement.unlock.minProgression) return HIDDEN;
    if (!controls.enabled) return HIDDEN;
    if (!gate.ready || !gate.day) return HIDDEN;
    if (completedThisSession >= controls.sessionCap) return HIDDEN;
    if (dailyCompleted(gate.day) >= controls.dailyCap) return HIDDEN;
    if (serverNow() - saved.monetization.rewardedAds.lastCompletedAtMs < controls.cooldownSeconds * 1000) return HIDDEN;
    if (!getRunCapabilities().ads) return HIDDEN;
    if (rewardedReady !== true || requestInFlight) {
        return {
            visible: requestInFlight,
            enabled: false,
            claimed: false,
            status: requestInFlight ? "VIDEO IN PROGRESS" : "",
            action: requestInFlight ? "STAND BY" : "",
        };
    }
    return {
        visible: true,
        enabled: true,
        claimed: false,
        status: "OPTIONAL VIDEO · REBOOT AT THE DEATH POINT, CELLS STAY BANKED",
        action: "WATCH · SECOND WIND",
    };
}

export async function refreshRewardedAdAvailability(): Promise<void> {
    rewardedReady = placementControls().enabled && getRunCapabilities().ads ? await isRewardedAdReady() : false;
}

export function rewardedAdDiagnostics(): RewardedAdDiagnostics {
    const runtime = getMonetizationRuntime();
    const capabilities = getRunCapabilities();
    return {
        ready: rewardedReady === true,
        testReady:
            runtime.controls.privateTestMode &&
            placementControls().enabled &&
            capabilities.host &&
            !capabilities.mock &&
            capabilities.ads &&
            rewardedReady === true &&
            !requestInFlight,
    };
}

export async function testRewardedAd(onPresentationChange?: (visible: boolean) => void): Promise<RewardedAdOutcome> {
    const runtime = getMonetizationRuntime();
    const capabilities = getRunCapabilities();
    if (!runtime.controls.privateTestMode) return { granted: false, message: "PRIVATE TEST MODE DISABLED" };
    if (!placementControls().enabled || !capabilities.host || capabilities.mock || !capabilities.ads) {
        return { granted: false, message: "RUN MOBILE AD HOST REQUIRED" };
    }
    rewardedReady = await isRewardedAdReady();
    if (!rewardedReady) return { granted: false, message: "NO VIDEO AVAILABLE RIGHT NOW" };
    if (requestInFlight) return { granted: false, message: "VIDEO ALREADY IN PROGRESS" };

    const rewardDay = trustedTimeGate().day;
    if (!rewardDay) return { granted: false, message: "TRUSTED TIME UNAVAILABLE" };
    requestInFlight = true;
    recordAnalytics("ad_requested", {
        placementId: SECOND_WIND_PLACEMENT_ID,
        adType: "rewarded",
        source: "private_test_bay",
    });
    // Portfolio-standard name alongside the game's own, so rewarded funnels
    // compare across titles.
    analytics.event("rewarded_ad_offered", { ad_display_id: SECOND_WIND_PLACEMENT_ID });
    onPresentationChange?.(true);
    const completed = await showRewardedAd(placement.id, `${placement.displayName} · Private Test`);
    onPresentationChange?.(false);
    requestInFlight = false;
    recordAnalytics("ad_result", {
        placementId: SECOND_WIND_PLACEMENT_ID,
        adType: "rewarded",
        source: "private_test_bay",
        result: completed ? "completed" : "unavailable_or_cancelled",
    });
    if (!completed) {
        analytics.event("rewarded_ad_dismissed", {
            ad_display_id: SECOND_WIND_PLACEMENT_ID,
            source: "private_test_bay",
        });
        rewardedReady = false;
        return { granted: false, message: "VIDEO NOT COMPLETED · NOTHING GRANTED" };
    }
    analytics.event("rewarded_ad_watched", { ad_display_id: SECOND_WIND_PLACEMENT_ID, source: "private_test_bay" });
    return { granted: true, message: "VIDEO CONFIRMED · NO REVIVE OUTSIDE A RUN" };
}

/**
 * Shows the Second Wind video. The revive is only ever applied by the caller
 * when `granted` is true, which requires a host-confirmed completion.
 */
export async function claimSecondWind(
    revivesUsedThisRun: number,
    onPresentationChange?: (visible: boolean) => void,
): Promise<RewardedAdOutcome> {
    const before = secondWindView(revivesUsedThisRun);
    if (!before.enabled || requestInFlight) return { granted: false, message: before.status };
    const rewardDay = trustedTimeGate().day;
    if (!rewardDay) return { granted: false, message: "TRUSTED TIME UNAVAILABLE" };

    requestInFlight = true;
    recordAnalytics("ad_requested", { placementId: SECOND_WIND_PLACEMENT_ID, adType: "rewarded" });
    // Portfolio-standard name alongside the game's own, so rewarded funnels
    // compare across titles.
    analytics.event("rewarded_ad_offered", { ad_display_id: SECOND_WIND_PLACEMENT_ID });
    onPresentationChange?.(true);
    const completed = await showRewardedAd(placement.id, placement.displayName);
    onPresentationChange?.(false);
    requestInFlight = false;
    recordAnalytics("ad_result", {
        placementId: SECOND_WIND_PLACEMENT_ID,
        adType: "rewarded",
        result: completed ? "completed" : "unavailable_or_cancelled",
    });
    if (!completed) {
        rewardedReady = false;
        return { granted: false, message: "VIDEO NOT COMPLETED · NOTHING CHANGED" };
    }
    analytics.event("rewarded_ad_watched", { ad_display_id: SECOND_WIND_PLACEMENT_ID });

    const applied = saveSystem.recordRewardedCompletion({
        claimId: claimId(),
        day: rewardDay,
        completedAtMs: serverNow(),
    });
    if (!applied.ok) return { granted: false, message: "SECOND WIND ALREADY USED THIS RUN" };
    completedThisSession += 1;
    await saveSystem.flush();
    recordAnalytics("reward_claimed", {
        placementId: SECOND_WIND_PLACEMENT_ID,
        rewardId: placement.rewardId,
        amount: 1,
    });
    return { granted: true, message: "BACK ON THE PAGE" };
}
