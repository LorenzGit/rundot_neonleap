import { getRunCapabilities, isInterstitialAdReady, recordAnalytics, showInterstitialAd } from "../sdk/runSdk.ts";
import { commerceEntitlementsReady, hasVerifiedEntitlement } from "./commerce.ts";
import { monetizationPlacements } from "./monetization/config.ts";
import { evaluateInterstitialGate, type InterstitialGateReason } from "./monetization/interstitialGate.ts";
import type { InterstitialPlacement } from "./monetization/placementRegistry.ts";
import { getMonetizationRuntime } from "./monetization/runtime.ts";
import { saveSystem } from "./save.ts";
import { serverNow, trustedTimeGate } from "./serverTime.ts";

import { analytics } from "./analytics/analyticsConfig.ts";
const RESULTS_PLACEMENT_ID = "interstitial_results_break";
const NO_INTERSTITIALS_ENTITLEMENT = "neonleap_neon_core";
const registeredPlacement = monetizationPlacements.require(RESULTS_PLACEMENT_ID);
if (registeredPlacement.type !== "interstitial") {
    throw new Error(`${RESULTS_PLACEMENT_ID} must be an interstitial placement`);
}
const placement: InterstitialPlacement = registeredPlacement;

let completedRunsAtSessionStart = 0;
let shownThisSession = 0;
let interstitialReady: boolean | null = null;
let evaluatedRunNumber = -1;
let requestInFlight = false;

export function initializeInterstitialAdsSession(): void {
    completedRunsAtSessionStart = saveSystem.get().records.totalRuns;
    shownThisSession = 0;
    interstitialReady = null;
    evaluatedRunNumber = -1;
    requestInFlight = false;
}

function placementControls(): {
    enabled: boolean;
    sessionCap: number;
    dailyCap: number;
    cooldownSeconds: number;
    everyNthRun: number;
} {
    const runtime = getMonetizationRuntime().controls;
    const remote = runtime.placements[RESULTS_PLACEMENT_ID];
    return {
        enabled: runtime.enabled && runtime.interstitialAdsEnabled && remote?.enabled === true,
        sessionCap: Math.min(placement.sessionCap, remote?.sessionCap ?? 0),
        dailyCap: Math.min(placement.dailyCap, remote?.dailyCap ?? 0),
        cooldownSeconds: Math.max(placement.cooldownSeconds, remote?.cooldownSeconds ?? placement.cooldownSeconds),
        everyNthRun: Math.max(placement.everyNthRun, remote?.everyNthRun ?? placement.everyNthRun),
    };
}

function shownToday(day: string): number {
    const saved = saveSystem.get().monetization.interstitialAds;
    return saved.day === day ? saved.shownToday : 0;
}

function currentGate(rewardedInteracted: boolean): InterstitialGateReason {
    const saved = saveSystem.get();
    const controls = placementControls();
    const trusted = trustedTimeGate();
    const capabilities = getRunCapabilities();
    return evaluateInterstitialGate({
        controlsEnabled: controls.enabled,
        rewardedInteracted,
        entitlementsVerified: commerceEntitlementsReady(),
        adFree: hasVerifiedEntitlement(NO_INTERSTITIALS_ENTITLEMENT),
        minCompletedSessions: placement.unlock.minCompletedSessions,
        minProgression: placement.unlock.minProgression,
        completedRunsAtSessionStart,
        totalRuns: saved.records.totalRuns,
        // NEONLEAP progression = best distance in metres (plan minProgression).
        progression: saved.records.bestDistance,
        everyNthRun: controls.everyNthRun,
        trustedTimeReady: trusted.ready && trusted.day !== null,
        shownThisSession,
        sessionCap: controls.sessionCap,
        shownToday: trusted.day ? shownToday(trusted.day) : 0,
        dailyCap: controls.dailyCap,
        sinceLastShownMs: serverNow() - saved.monetization.interstitialAds.lastShownAtMs,
        cooldownMs: controls.cooldownSeconds * 1000,
        hostReady: capabilities.host && !capabilities.mock && capabilities.ads,
        adReady: interstitialReady === true,
        alreadyEvaluated: evaluatedRunNumber === saved.records.totalRuns,
        inFlight: requestInFlight,
    });
}

export function resultsBreakLabel(): string {
    if (hasVerifiedEntitlement(NO_INTERSTITIALS_ENTITLEMENT)) return "AD-FREE FOREVER ACTIVE";
    return "ADS ONLY APPEAR BETWEEN ELIGIBLE RUNS";
}

export async function refreshInterstitialAdAvailability(): Promise<void> {
    interstitialReady = placementControls().enabled && getRunCapabilities().ads ? await isInterstitialAdReady() : false;
}

export function interstitialAdDiagnostics(): { ready: boolean; testReady: boolean } {
    const runtime = getMonetizationRuntime();
    const capabilities = getRunCapabilities();
    return {
        ready: interstitialReady === true,
        testReady:
            runtime.controls.privateTestMode &&
            placementControls().enabled &&
            capabilities.host &&
            !capabilities.mock &&
            capabilities.ads &&
            interstitialReady === true &&
            !requestInFlight,
    };
}

export async function testInterstitialAd(onPresentationChange?: (visible: boolean) => void): Promise<string> {
    const runtime = getMonetizationRuntime();
    const capabilities = getRunCapabilities();
    if (!runtime.controls.privateTestMode) return "PRIVATE TEST MODE DISABLED";
    if (!placementControls().enabled || !capabilities.host || capabilities.mock || !capabilities.ads) {
        return "RUN MOBILE AD HOST REQUIRED";
    }
    if (!interstitialAdDiagnostics().testReady) {
        interstitialReady = await isInterstitialAdReady();
        if (!interstitialReady) return "NO INTERSTITIAL AVAILABLE RIGHT NOW";
    }
    if (requestInFlight) return "AD ALREADY IN PROGRESS";
    requestInFlight = true;
    recordAnalytics("ad_requested", {
        placementId: RESULTS_PLACEMENT_ID,
        adType: "interstitial",
        source: "private_test_bay",
    });
    onPresentationChange?.(true);
    const displayed = await showInterstitialAd(placement.id, `${placement.displayName} · Private Test`);
    onPresentationChange?.(false);
    requestInFlight = false;
    interstitialReady = false;
    recordAnalytics("ad_result", {
        placementId: RESULTS_PLACEMENT_ID,
        adType: "interstitial",
        source: "private_test_bay",
        result: displayed ? "displayed" : "unavailable_or_suppressed",
    });
    return displayed ? "INTERSTITIAL DISPLAY CONFIRMED" : "AD NOT DISPLAYED · NOTHING INTERRUPTED";
}

export async function maybeShowResultsInterstitial(
    rewardedInteracted: boolean,
    onPresentationChange?: (visible: boolean) => void,
): Promise<{ displayed: boolean; reason: InterstitialGateReason }> {
    const reason = currentGate(rewardedInteracted);
    const runNumber = saveSystem.get().records.totalRuns;
    recordAnalytics("interstitial_gate_evaluated", {
        placementId: RESULTS_PLACEMENT_ID,
        runNumber,
        result: reason,
    });
    if (reason !== "eligible") return { displayed: false, reason };

    evaluatedRunNumber = runNumber;
    requestInFlight = true;
    recordAnalytics("ad_requested", { placementId: RESULTS_PLACEMENT_ID, adType: "interstitial" });
    onPresentationChange?.(true);
    const displayed = await showInterstitialAd(placement.id, placement.displayName);
    onPresentationChange?.(false);
    requestInFlight = false;
    interstitialReady = false;
    recordAnalytics("ad_result", {
        placementId: RESULTS_PLACEMENT_ID,
        adType: "interstitial",
        result: displayed ? "displayed" : "unavailable_or_suppressed",
    });
    if (!displayed) return { displayed: false, reason: "no-fill" };
    // Portfolio-standard name alongside the game's own, so interstitial load
    // compares across titles — the number to watch against D1 when tuning.
    analytics.event("interstitial_shown", { ad_display_id: RESULTS_PLACEMENT_ID });

    const day = trustedTimeGate().day;
    if (day) {
        shownThisSession += 1;
        saveSystem.recordInterstitialShown({ day, shownAtMs: serverNow() });
        await saveSystem.flush();
    }
    return { displayed: true, reason: "eligible" };
}
