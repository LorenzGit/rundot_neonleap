import { createMonetizationPlan } from "./monetizationPlan.ts";
import { createPlacementRegistry } from "./placementRegistry.ts";
import { createProductRegistry } from "./productRegistry.ts";

export const monetizationPlan = createMonetizationPlan({
    version: 1,
    model: "hybrid",
    nonPayerPromise:
        "Cells, upgrades, missions, daily drops, and every powerup are fully earnable in play. Money only removes interstitials, adds a cell bonus and a cosmetic trail, or tops up cells; it never unlocks content a free player cannot reach.",
    purchaseArchitecture: "shop-entitlements",
    architectureRationale:
        "NEON CORE is a permanent entitlement (ad removal + cell bonus + trail) that needs the RUN Shop ledger for idempotency, refunds, revocation, and cross-device restore; CELL CACHE is a consumable redeemed from fulfilled order history.",
    firstExposure: {
        valueMoment: "Finish one run and clear 150 m best distance before any offer or ad placement can activate.",
        minCompletedSessions: 1,
        // Progression for NEONLEAP is best distance in metres.
        minProgression: 150,
    },
    primaryKpis: ["rewarded_completion_rate", "game_payer_conversion", "monetization_revenue_per_dau"],
    guardrails: {
        retention: "D1/D7 retention for eligible exposed players versus holdout",
        sessionHealth: "Runs per session and abandonment immediately after a results break",
        economyHealth: "Cells/min earned versus upgrade prices; revived runs are flagged in results",
        reliability: "Purchase/ad error rate, duplicate grants, and entitlement reconciliation failures",
    },
});

export const monetizationPlacements = createPlacementRegistry([
    {
        id: "rewarded_second_wind",
        displayName: "Second Wind",
        type: "rewarded",
        enabledByDefault: false,
        unlock: {
            minCompletedSessions: 1,
            minProgression: 150,
            requireValueMoment: true,
        },
        cooldownSeconds: 120,
        sessionCap: 3,
        dailyCap: 3,
        subscriberPolicy: "same-as-free",
        noAdFallback: "disable-with-message",
        rewardId: "second_wind_revive",
        rewardAmount: 1,
    },
    {
        id: "interstitial_results_break",
        displayName: "Results Break",
        type: "interstitial",
        enabledByDefault: false,
        unlock: {
            minCompletedSessions: 2,
            minProgression: 150,
            requireValueMoment: true,
        },
        cooldownSeconds: 300,
        sessionCap: 2,
        dailyCap: 6,
        subscriberPolicy: "skip",
        noAdFallback: "hide",
        naturalBreak: "After the results tally is read, before the player explicitly starts another run",
        excludeFirstSession: true,
        everyNthRun: 3,
    },
]);

export const CELL_CACHES: Readonly<Record<string, { cells: number; catalogItemId: string }>> = {
    cell_cache: { cells: 500, catalogItemId: "neonleap_cell_cache" },
};

export const NEON_CORE_ENTITLEMENT_ID = "neonleap_neon_core";

/** Maps a fulfilled catalog item back to the cells it is worth. */
export function cellsForCatalogItem(itemId: string): number {
    for (const entry of Object.values(CELL_CACHES)) {
        if (entry.catalogItemId === itemId) return entry.cells;
    }
    return 0;
}

export const monetizationProducts = createProductRegistry([
    {
        id: "neon_core",
        catalogItemId: "neonleap_neon_core",
        kind: "durable",
        expectedEntitlementIds: [NEON_CORE_ENTITLEMENT_ID],
        unique: true,
        unlockDescription: "Visible after one completed run: removes interstitials, +25% cells, ion-white trail.",
    },
    {
        id: "cell_cache",
        catalogItemId: "neonleap_cell_cache",
        kind: "consumable",
        expectedEntitlementIds: [],
        unique: false,
        unlockDescription: "500 cells instantly. Always earnable by playing.",
    },
]);
