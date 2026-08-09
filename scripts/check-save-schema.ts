import assert from "node:assert/strict";
import {
    createDefaultGameSave,
    parseGameSave,
    SAVE_VERSION,
    UPGRADE_COSTS,
    upgradeCost,
} from "../src/systems/saveSchema.ts";

const defaults = createDefaultGameSave(true);

assert.equal(SAVE_VERSION, 1);
assert.equal(defaults.settings.reducedMotion, true, "system reduced-motion must seed the default save");
assert.equal(defaults.wallet.cells, 0);
assert.equal(defaults.upgrades.headStart, 0);
assert.equal(defaults.entitlements.neonCore, false, "NEON CORE must never default to owned");
assert.equal(defaults.missions.dateKey, "", "no mission board before the first trusted day");

assert.deepEqual([...UPGRADE_COSTS], [60, 140, 300, 620, 1200], "§10 upgrade prices are canon");
assert.equal(upgradeCost(0), 60);
assert.equal(upgradeCost(5), null, "level five is the cap");
assert.equal(upgradeCost(-3), null);
assert.equal(upgradeCost(1.5), null, "fractional levels are corrupt input, not a price");

assert.equal(parseGameSave(null, defaults), null, "no stored payload means defaults, not a partial save");
assert.equal(parseGameSave("not json", defaults), null, "corrupt payloads must fall back to defaults");
assert.equal(
    parseGameSave(JSON.stringify({ version: 99, settings: {}, records: {} }), defaults),
    null,
    "an unknown save version must be rejected rather than half-read",
);

const healthy = parseGameSave(
    JSON.stringify({
        version: 1,
        wallet: { cells: 480 },
        records: {
            bestDistance: 1420,
            bestScore: 20_115,
            totalRuns: 12,
            totalDistance: 8100,
            totalCells: 640,
            nearMisses: 44,
            smashes: 9,
            deaths: 11,
            revives: 2,
        },
        upgrades: { capacitor: 2, luckyCoil: 0, magnetCore: 1, flowGrid: 0, headStart: 3 },
        missions: {
            dateKey: "2026-08-07",
            slots: [
                {
                    id: "2026-08-07:distance",
                    kind: "distance",
                    target: 1200,
                    reward: 80,
                    progress: 900,
                    claimed: false,
                },
                { id: "2026-08-07:cells", kind: "cells", target: 40, reward: 60, progress: 40, claimed: true },
            ],
        },
        daily: { lastClaimDay: "2026-08-07", totalClaims: 4, claimIds: ["daily-reward:2026-08-07"] },
        entitlements: { neonCore: true },
        monetization: {
            pendingPurchaseIntent: null,
            redeemedOrderIds: ["order-1", "order-2"],
            rewardedAds: { day: "2026-08-07", completedToday: 1, lastCompletedAtMs: 42, claimIds: ["second-wind:3:1"] },
            interstitialAds: { day: "2026-08-07", shownToday: 1, lastShownAtMs: 64 },
        },
        settings: {
            musicEnabled: false,
            sfxEnabled: true,
            hapticsEnabled: false,
            reducedMotion: false,
            performanceHud: true,
            dailyReminder: true,
        },
        progress: { controlsSeen: true },
    }),
    defaults,
);

assert.ok(healthy, "a healthy current-version save must load");
assert.equal(healthy.records.bestDistance, 1420);
assert.equal(healthy.wallet.cells, 480);
assert.equal(healthy.upgrades.headStart, 3);
assert.equal(healthy.missions.slots.length, 2);
assert.equal(healthy.missions.slots[1]?.claimed, true);
assert.equal(healthy.daily.totalClaims, 4);
assert.equal(healthy.entitlements.neonCore, true);
assert.deepEqual(healthy.monetization.redeemedOrderIds, ["order-1", "order-2"]);
assert.equal(healthy.settings.performanceHud, true);
assert.equal(healthy.progress.controlsSeen, true);

const hostile = parseGameSave(
    JSON.stringify({
        version: 1,
        wallet: { cells: -900 },
        records: {
            bestDistance: "999999999999999999999",
            bestScore: Number.NaN,
            totalRuns: -4,
            totalDistance: null,
            totalCells: [],
            nearMisses: {},
            smashes: "yes",
            deaths: Number.POSITIVE_INFINITY,
            revives: -1,
        },
        upgrades: { capacitor: 99, luckyCoil: -2, magnetCore: "max", flowGrid: 2.7, headStart: null },
        missions: {
            dateKey: 12345,
            slots: [
                { id: 7, kind: "distance", target: 100, reward: 40, progress: 0, claimed: false },
                { id: "x", kind: "cells", target: 0, reward: 40, progress: 0, claimed: false },
                { id: "y", kind: "cells", target: 40, reward: 40, progress: 4000, claimed: "no" },
            ],
        },
        daily: { lastClaimDay: 7, totalClaims: -3, claimIds: "nope" },
        entitlements: { neonCore: "yes" },
        monetization: {
            pendingPurchaseIntent: { intentId: 1 },
            redeemedOrderIds: [1, "ok", null],
            rewardedAds: { day: 4, completedToday: -2, lastCompletedAtMs: "later", claimIds: {} },
            interstitialAds: { day: false, shownToday: "many", lastShownAtMs: -5 },
        },
        settings: {
            musicEnabled: "yes",
            sfxEnabled: 1,
            hapticsEnabled: null,
            reducedMotion: undefined,
            performanceHud: [],
            dailyReminder: {},
        },
        progress: { controlsSeen: "sure" },
    }),
    defaults,
);

assert.ok(hostile, "a hostile payload of the right version loads with every field sanitised");
assert.equal(hostile.wallet.cells, 0, "negative cells must clamp to zero");
assert.equal(hostile.records.totalRuns, 0);
assert.equal(hostile.records.deaths, 0, "non-finite counters must fall back to zero");
assert.equal(hostile.upgrades.capacitor, 5, "upgrade levels must clamp to the cap");
assert.equal(hostile.upgrades.luckyCoil, 0);
assert.equal(hostile.upgrades.flowGrid, 2, "fractional levels floor to an integer");
assert.deepEqual(hostile.missions, { dateKey: "", slots: [] }, "a torn mission board drops whole, never half");
assert.equal(hostile.daily.lastClaimDay, null);
assert.deepEqual(hostile.daily.claimIds, []);
assert.equal(hostile.entitlements.neonCore, false, "a string is not a verified entitlement");
assert.equal(hostile.monetization.pendingPurchaseIntent, null, "a malformed intent must be dropped");
assert.deepEqual(hostile.monetization.redeemedOrderIds, ["ok"], "only string order ids survive");
assert.equal(hostile.settings.musicEnabled, defaults.settings.musicEnabled);
assert.equal(hostile.progress.controlsSeen, false);

// Mission slots: progress clamps to target, zero targets are dropped.
const board = parseGameSave(
    JSON.stringify({
        version: 1,
        settings: defaults.settings,
        records: defaults.records,
        missions: {
            dateKey: "2026-08-08",
            slots: [
                { id: "a", kind: "cells", target: 40, reward: 60, progress: 4000, claimed: false },
                { id: "b", kind: "smash", target: 0, reward: 60, progress: 0, claimed: false },
                { id: "c", kind: "tier", target: 5, reward: 80, progress: 2, claimed: false },
                { id: "d", kind: "distance", target: 900, reward: 80, progress: 0, claimed: false },
            ],
        },
    }),
    defaults,
);
assert.ok(board);
assert.equal(board.missions.slots.length, 3, "boards cap at three slots and drop zero-target missions");
assert.equal(board.missions.slots[0]?.progress, 40, "progress must clamp to the target");

console.log("save schema check ok: defaults, healthy load, hostile sanitisation, mission board rules");
