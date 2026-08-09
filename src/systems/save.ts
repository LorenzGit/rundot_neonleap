import type { UpgradeId } from "../game/core.ts";
import { getRunCapabilities, readAppStorage, writeAppStorage } from "../sdk/runSdk.ts";
import { analytics } from "./analytics/analyticsConfig.ts";
import type { PendingPurchaseIntent } from "./monetization/purchaseCoordinator.ts";
import {
    createDefaultGameSave,
    type GameSaveV1,
    type GameSettings,
    type MissionState,
    nonNegativeInteger,
    parseGameSave,
    UPGRADE_LEVEL_CAP,
    upgradeCost,
} from "./saveSchema.ts";

export {
    type DailyRewardSave,
    type GameRecords,
    type GameSaveV1,
    type GameSettings,
    type InterstitialAdsSave,
    type MissionSlot,
    type MissionState,
    parseGameSave,
    type RewardedAdsSave,
    SAVE_VERSION,
    UPGRADE_COSTS,
    UPGRADE_IDS,
    UPGRADE_LEVEL_CAP,
    upgradeCost,
} from "./saveSchema.ts";

// DESIGN.md names the save `neonleap.save.v1`, but RUN appStorage keys must
// not contain a dot (writes fail silently) — dashes carry the same identity.
const SAVE_KEY = "neonleap-save-v1";
const LOCAL_SAVE_KEY = "neonleap.local-save";
export type SaveSource = "run" | "local" | "defaults";

export const DEFAULT_SAVE = createDefaultGameSave(window.matchMedia("(prefers-reduced-motion: reduce)").matches);

let state: GameSaveV1 = structuredClone(DEFAULT_SAVE);
let lastSerialized = "";
let pendingSerialized: string | null = null;
let flushInFlight: Promise<boolean> | null = null;

function hostedStorage(): boolean {
    const capabilities = getRunCapabilities();
    return capabilities.host && !capabilities.mock && capabilities.storage;
}

function readLocal(): string | null {
    try {
        return window.localStorage.getItem(LOCAL_SAVE_KEY);
    } catch {
        return null;
    }
}

async function persist(serialized: string): Promise<boolean> {
    if (hostedStorage()) return writeAppStorage(SAVE_KEY, serialized);
    try {
        window.localStorage.setItem(LOCAL_SAVE_KEY, serialized);
        return true;
    } catch (error) {
        console.warn("[save] local fallback write failed", error);
        return false;
    }
}

export interface RunResult {
    distance: number;
    score: number;
    cells: number;
    nearMisses: number;
    smashes: number;
    stumbles: number;
    died: boolean;
    revives: number;
}

/** NEON CORE grants +25% cells from every source (§11). */
function cellBonusMultiplier(): number {
    return state.entitlements.neonCore ? 1.25 : 1;
}

export const saveSystem = {
    async load(): Promise<SaveSource> {
        if (hostedStorage()) {
            const remote = await readAppStorage(SAVE_KEY);
            if (remote.ok) {
                state = parseGameSave(remote.value, DEFAULT_SAVE) ?? structuredClone(DEFAULT_SAVE);
                lastSerialized = remote.value ?? JSON.stringify(state);
                return remote.value ? "run" : "defaults";
            }
            state = structuredClone(DEFAULT_SAVE);
            lastSerialized = JSON.stringify(state);
            return "defaults";
        }
        const localRaw = readLocal();
        const local = parseGameSave(localRaw, DEFAULT_SAVE);
        state = local ?? structuredClone(DEFAULT_SAVE);
        lastSerialized = localRaw ?? JSON.stringify(state);
        return local ? "local" : "defaults";
    },

    get(): Readonly<GameSaveV1> {
        return state;
    },

    updateSettings(patch: Partial<GameSettings>): void {
        state = { ...state, settings: { ...state.settings, ...patch } };
    },

    markControlsSeen(): void {
        if (state.progress.controlsSeen) return;
        state = { ...state, progress: { ...state.progress, controlsSeen: true } };
    },

    /** Re-arms onboarding so the next run coaches again. */
    resetControlsSeen(): void {
        if (!state.progress.controlsSeen) return;
        state = { ...state, progress: { ...state.progress, controlsSeen: false } };
    },

    /** Banks a finished (or revived-and-finished) run. Returns cells granted. */
    recordRun(result: RunResult): number {
        const distance = nonNegativeInteger(result.distance);
        const score = nonNegativeInteger(result.score);
        const cells = Math.round(nonNegativeInteger(result.cells) * cellBonusMultiplier());
        // Milestones read the PREVIOUS records before they are overwritten.
        if (distance > state.records.bestDistance) {
            analytics.event("milestone_reached", {
                milestone: "best_distance",
                value: distance,
                previous: state.records.bestDistance,
            });
        }
        if (score > state.records.bestScore) {
            analytics.event("milestone_reached", {
                milestone: "best_score",
                value: score,
                previous: state.records.bestScore,
            });
        }
        state = {
            ...state,
            records: {
                bestDistance: Math.max(state.records.bestDistance, distance),
                bestScore: Math.max(state.records.bestScore, score),
                totalRuns: state.records.totalRuns + 1,
                totalDistance: state.records.totalDistance + distance,
                totalCells: state.records.totalCells + cells,
                nearMisses: state.records.nearMisses + nonNegativeInteger(result.nearMisses),
                smashes: state.records.smashes + nonNegativeInteger(result.smashes),
                deaths: state.records.deaths + (result.died ? 1 : 0),
                revives: state.records.revives + nonNegativeInteger(result.revives),
            },
            wallet: { cells: state.wallet.cells + cells },
        };
        return cells;
    },

    /** Grants cells from a non-run source (mission, daily, purchase). */
    grantCells(amount: number): number {
        const granted = Math.round(nonNegativeInteger(amount) * cellBonusMultiplier());
        state = {
            ...state,
            wallet: { cells: state.wallet.cells + granted },
            records: { ...state.records, totalCells: state.records.totalCells + granted },
        };
        return granted;
    },

    spendCells(cost: number): boolean {
        const amount = nonNegativeInteger(cost);
        if (state.wallet.cells < amount) return false;
        state = { ...state, wallet: { cells: state.wallet.cells - amount } };
        return true;
    },

    /** Buys the next level of an upgrade track. Returns the new level, or null. */
    buyUpgrade(id: UpgradeId): number | null {
        const level = state.upgrades[id];
        const cost = upgradeCost(level);
        if (cost === null || level >= UPGRADE_LEVEL_CAP) return null;
        if (!this.spendCells(cost)) return null;
        state = { ...state, upgrades: { ...state.upgrades, [id]: level + 1 } };
        return level + 1;
    },

    setMissions(missions: MissionState): void {
        state = { ...state, missions: structuredClone(missions) };
    },

    /** Local mirror of the host-verified NEON CORE entitlement. */
    setNeonCoreEntitlement(owned: boolean): void {
        if (state.entitlements.neonCore === owned) return;
        state = { ...state, entitlements: { ...state.entitlements, neonCore: owned } };
    },

    /**
     * Turns one fulfilled consumable order into cells, exactly once. The order
     * id is the idempotency key, so a replayed history can never double-grant.
     */
    redeemCellOrder(orderId: string, cells: number): boolean {
        if (state.monetization.redeemedOrderIds.includes(orderId)) return false;
        const granted = Math.round(nonNegativeInteger(cells) * cellBonusMultiplier());
        state = {
            ...state,
            wallet: { cells: state.wallet.cells + granted },
            records: { ...state.records, totalCells: state.records.totalCells + granted },
            monetization: {
                ...state.monetization,
                redeemedOrderIds: [...state.monetization.redeemedOrderIds, orderId].slice(-90),
            },
        };
        return true;
    },

    setPendingPurchaseIntent(pendingPurchaseIntent: PendingPurchaseIntent | null): void {
        state = { ...state, monetization: { ...state.monetization, pendingPurchaseIntent } };
    },

    /** Records a host-verified rewarded completion. The grant itself is a revive. */
    recordRewardedCompletion(input: { claimId: string; day: string; completedAtMs: number }): {
        ok: boolean;
        reason: "ready" | "already-claimed";
        previous: GameSaveV1;
    } {
        const previous = structuredClone(state);
        if (state.monetization.rewardedAds.claimIds.includes(input.claimId)) {
            return { ok: false, reason: "already-claimed", previous };
        }
        const completedToday =
            state.monetization.rewardedAds.day === input.day ? state.monetization.rewardedAds.completedToday : 0;
        state = {
            ...state,
            monetization: {
                ...state.monetization,
                rewardedAds: {
                    day: input.day,
                    completedToday: completedToday + 1,
                    lastCompletedAtMs: nonNegativeInteger(input.completedAtMs),
                    claimIds: [...state.monetization.rewardedAds.claimIds, input.claimId].slice(-90),
                },
            },
        };
        return { ok: true, reason: "ready", previous };
    },

    recordInterstitialShown(input: { day: string; shownAtMs: number }): void {
        const shownToday =
            state.monetization.interstitialAds.day === input.day ? state.monetization.interstitialAds.shownToday : 0;
        state = {
            ...state,
            monetization: {
                ...state.monetization,
                interstitialAds: {
                    day: input.day,
                    shownToday: shownToday + 1,
                    lastShownAtMs: nonNegativeInteger(input.shownAtMs),
                },
            },
        };
    },

    applyDailyReward(input: { day: string; cells: number }): {
        ok: boolean;
        reason: "ready" | "already-claimed";
        previous: GameSaveV1;
        granted: number;
    } {
        const claimId = `daily-reward:${input.day}`;
        const previous = structuredClone(state);
        if (state.daily.claimIds.includes(claimId)) {
            return { ok: false, reason: "already-claimed", previous, granted: 0 };
        }
        const granted = Math.round(nonNegativeInteger(input.cells) * cellBonusMultiplier());
        state = {
            ...state,
            wallet: { cells: state.wallet.cells + granted },
            records: { ...state.records, totalCells: state.records.totalCells + granted },
            daily: {
                lastClaimDay: input.day,
                totalClaims: state.daily.totalClaims + 1,
                claimIds: [...state.daily.claimIds, claimId].slice(-90),
            },
        };
        return { ok: true, reason: "ready", previous, granted };
    },

    restore(snapshot: GameSaveV1): void {
        state = structuredClone(snapshot);
    },

    async flush(): Promise<boolean> {
        const serialized = JSON.stringify(state);
        if (serialized === lastSerialized && pendingSerialized === null) return true;
        pendingSerialized = serialized;
        if (flushInFlight) return flushInFlight;
        flushInFlight = (async () => {
            let succeeded = true;
            while (pendingSerialized !== null) {
                const next = pendingSerialized;
                pendingSerialized = null;
                if (next === lastSerialized) continue;
                if (await persist(next)) lastSerialized = next;
                else succeeded = false;
            }
            return succeeded;
        })().finally(() => {
            flushInFlight = null;
        });
        return flushInFlight;
    },
};
