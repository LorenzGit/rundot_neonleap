import type { UpgradeId, UpgradeLevels } from "../game/core.ts";
import type { PendingPurchaseIntent } from "./monetization/purchaseCoordinator.ts";

export const SAVE_VERSION = 1;

/** The five permanent Upgrade Bay tracks (DESIGN.md §10), each level 0..5. */
export const UPGRADE_IDS: readonly UpgradeId[] = ["capacitor", "luckyCoil", "magnetCore", "flowGrid", "headStart"];
export const UPGRADE_LEVEL_CAP = 5;
/** Cost of the NEXT level per current level: 60 / 140 / 300 / 620 / 1200 cells. */
export const UPGRADE_COSTS: readonly number[] = [60, 140, 300, 620, 1200];

/** Price of going from `level` to `level + 1`, or null at the cap. */
export function upgradeCost(level: number): number | null {
    if (!Number.isInteger(level) || level < 0 || level >= UPGRADE_LEVEL_CAP) return null;
    return UPGRADE_COSTS[level] ?? null;
}

export interface GameSettings {
    musicEnabled: boolean;
    sfxEnabled: boolean;
    hapticsEnabled: boolean;
    reducedMotion: boolean;
    /** The on-device frame counter overlay. */
    performanceHud: boolean;
    /** Whether the player wants a nudge when the nightly supply drop is ready. */
    dailyReminder: boolean;
}

export interface GameRecords {
    bestDistance: number;
    bestScore: number;
    totalRuns: number;
    totalDistance: number;
    totalCells: number;
    nearMisses: number;
    smashes: number;
    deaths: number;
    revives: number;
}

export interface MissionSlot {
    id: string;
    kind: string;
    target: number;
    reward: number;
    progress: number;
    claimed: boolean;
}

export interface MissionState {
    /** The local day (YYYY-MM-DD) the slots were dealt for; "" means none yet. */
    dateKey: string;
    slots: MissionSlot[];
}

export interface DailyRewardSave {
    lastClaimDay: string | null;
    totalClaims: number;
    claimIds: string[];
}

export interface RewardedAdsSave {
    day: string | null;
    completedToday: number;
    lastCompletedAtMs: number;
    claimIds: string[];
}

export interface InterstitialAdsSave {
    day: string | null;
    shownToday: number;
    lastShownAtMs: number;
}

export interface GameSaveV1 {
    version: 1;
    wallet: {
        cells: number;
    };
    records: GameRecords;
    upgrades: UpgradeLevels;
    missions: MissionState;
    /** The nightly supply drop track (the scaffold's forgiving 7-day cycle). */
    daily: DailyRewardSave;
    /** Local mirror only — the SDK entitlement ledger stays authoritative. */
    entitlements: {
        neonCore: boolean;
    };
    monetization: {
        pendingPurchaseIntent: PendingPurchaseIntent | null;
        /** Fulfilled consumable orders already turned into cells. */
        redeemedOrderIds: string[];
        rewardedAds: RewardedAdsSave;
        interstitialAds: InterstitialAdsSave;
    };
    settings: GameSettings;
    progress: {
        /** FTUE hints seen — a returning player is never coached again. */
        controlsSeen: boolean;
    };
}

export function createDefaultUpgrades(): UpgradeLevels {
    return { capacitor: 0, luckyCoil: 0, magnetCore: 0, flowGrid: 0, headStart: 0 };
}

export function createDefaultGameSave(reducedMotion: boolean): GameSaveV1 {
    return {
        version: SAVE_VERSION,
        wallet: {
            cells: 0,
        },
        records: {
            bestDistance: 0,
            bestScore: 0,
            totalRuns: 0,
            totalDistance: 0,
            totalCells: 0,
            nearMisses: 0,
            smashes: 0,
            deaths: 0,
            revives: 0,
        },
        upgrades: createDefaultUpgrades(),
        missions: {
            dateKey: "",
            slots: [],
        },
        daily: {
            lastClaimDay: null,
            totalClaims: 0,
            claimIds: [],
        },
        entitlements: {
            neonCore: false,
        },
        monetization: {
            pendingPurchaseIntent: null,
            redeemedOrderIds: [],
            rewardedAds: {
                day: null,
                completedToday: 0,
                lastCompletedAtMs: 0,
                claimIds: [],
            },
            interstitialAds: {
                day: null,
                shownToday: 0,
                lastShownAtMs: 0,
            },
        },
        settings: {
            musicEnabled: true,
            sfxEnabled: true,
            hapticsEnabled: true,
            reducedMotion,
            performanceHud: false,
            dailyReminder: false,
        },
        progress: {
            controlsSeen: false,
        },
    };
}

function booleanOr(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

export function nonNegativeInteger(value: unknown, fallback = 0): number {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function upgradeLevelOr(value: unknown): number {
    return Math.min(UPGRADE_LEVEL_CAP, nonNegativeInteger(value));
}

function parsePendingPurchaseIntent(value: unknown): PendingPurchaseIntent | null {
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (
        typeof candidate.intentId !== "string" ||
        typeof candidate.productId !== "string" ||
        typeof candidate.catalogItemId !== "string" ||
        typeof candidate.idempotencyKey !== "string" ||
        typeof candidate.createdAtMs !== "number" ||
        !Number.isFinite(candidate.createdAtMs)
    ) {
        return null;
    }
    return {
        intentId: candidate.intentId,
        productId: candidate.productId,
        catalogItemId: candidate.catalogItemId,
        idempotencyKey: candidate.idempotencyKey,
        createdAtMs: candidate.createdAtMs,
    };
}

function parseStringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(-90) : [];
}

function parseMissionSlot(value: unknown): MissionSlot | null {
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.kind !== "string") return null;
    const target = nonNegativeInteger(candidate.target);
    if (target <= 0) return null;
    return {
        id: candidate.id,
        kind: candidate.kind,
        target,
        reward: nonNegativeInteger(candidate.reward),
        progress: Math.min(target, nonNegativeInteger(candidate.progress)),
        claimed: candidate.claimed === true,
    };
}

function parseMissions(value: unknown): MissionState {
    if (!value || typeof value !== "object") return { dateKey: "", slots: [] };
    const candidate = value as Record<string, unknown>;
    const dateKey = typeof candidate.dateKey === "string" ? candidate.dateKey : "";
    const slots = Array.isArray(candidate.slots)
        ? candidate.slots
              .map(parseMissionSlot)
              .filter((slot): slot is MissionSlot => slot !== null)
              .slice(0, 3)
        : [];
    // Slots without their day are meaningless — a torn payload drops both.
    return dateKey ? { dateKey, slots } : { dateKey: "", slots: [] };
}

/**
 * Save migrations, keyed by the version they upgrade FROM. NEONLEAP is a fresh
 * game — there are no legacy saves in the wild, so the list is empty — but the
 * version gate below is permanent: an unknown version is never half-read.
 */
const MIGRATIONS: Readonly<Record<number, (raw: unknown) => unknown>> = {};

function migrateToCurrent(raw: unknown, version: number): unknown | null {
    let current = raw;
    for (let step = version; step < SAVE_VERSION; step += 1) {
        const migration = MIGRATIONS[step];
        if (!migration) return null;
        current = migration(current);
    }
    return current;
}

export function parseGameSave(
    raw: string | null,
    defaults: GameSaveV1 = createDefaultGameSave(false),
): GameSaveV1 | null {
    if (!raw) return null;
    try {
        let parsed = JSON.parse(raw) as { version?: number };
        const version = typeof parsed.version === "number" ? parsed.version : Number.NaN;
        if (version !== SAVE_VERSION) {
            if (!Number.isInteger(version) || version < 1 || version > SAVE_VERSION) return null;
            const migrated = migrateToCurrent(parsed, version);
            if (migrated === null) return null;
            parsed = migrated as { version?: number };
            if (parsed.version !== SAVE_VERSION) return null;
        }
        const candidate = parsed as Omit<Partial<GameSaveV1>, "version" | "progress" | "records" | "settings"> & {
            version?: number;
            progress?: Partial<GameSaveV1["progress"]>;
            records?: Partial<GameRecords>;
            settings?: Partial<GameSettings>;
        };
        if (!candidate.settings || !candidate.records) return null;

        const rewardedAds = candidate.monetization?.rewardedAds;
        const interstitialAds = candidate.monetization?.interstitialAds;
        const upgrades = candidate.upgrades ?? ({} as Partial<UpgradeLevels>);

        return {
            version: SAVE_VERSION,
            wallet: {
                cells: nonNegativeInteger(candidate.wallet?.cells),
            },
            records: {
                bestDistance: nonNegativeInteger(candidate.records.bestDistance),
                bestScore: nonNegativeInteger(candidate.records.bestScore),
                totalRuns: nonNegativeInteger(candidate.records.totalRuns),
                totalDistance: nonNegativeInteger(candidate.records.totalDistance),
                totalCells: nonNegativeInteger(candidate.records.totalCells),
                nearMisses: nonNegativeInteger(candidate.records.nearMisses),
                smashes: nonNegativeInteger(candidate.records.smashes),
                deaths: nonNegativeInteger(candidate.records.deaths),
                revives: nonNegativeInteger(candidate.records.revives),
            },
            upgrades: {
                capacitor: upgradeLevelOr(upgrades.capacitor),
                luckyCoil: upgradeLevelOr(upgrades.luckyCoil),
                magnetCore: upgradeLevelOr(upgrades.magnetCore),
                flowGrid: upgradeLevelOr(upgrades.flowGrid),
                headStart: upgradeLevelOr(upgrades.headStart),
            },
            missions: parseMissions(candidate.missions),
            daily: {
                lastClaimDay: typeof candidate.daily?.lastClaimDay === "string" ? candidate.daily.lastClaimDay : null,
                totalClaims: nonNegativeInteger(candidate.daily?.totalClaims),
                claimIds: parseStringList(candidate.daily?.claimIds),
            },
            entitlements: {
                // Never trusted for gating on its own — the host re-verifies.
                neonCore: booleanOr(candidate.entitlements?.neonCore, false),
            },
            monetization: {
                pendingPurchaseIntent: parsePendingPurchaseIntent(candidate.monetization?.pendingPurchaseIntent),
                redeemedOrderIds: parseStringList(candidate.monetization?.redeemedOrderIds),
                rewardedAds: {
                    day: typeof rewardedAds?.day === "string" ? rewardedAds.day : null,
                    completedToday: nonNegativeInteger(rewardedAds?.completedToday),
                    lastCompletedAtMs: nonNegativeInteger(rewardedAds?.lastCompletedAtMs),
                    claimIds: parseStringList(rewardedAds?.claimIds),
                },
                interstitialAds: {
                    day: typeof interstitialAds?.day === "string" ? interstitialAds.day : null,
                    shownToday: nonNegativeInteger(interstitialAds?.shownToday),
                    lastShownAtMs: nonNegativeInteger(interstitialAds?.lastShownAtMs),
                },
            },
            settings: {
                musicEnabled: booleanOr(candidate.settings.musicEnabled, defaults.settings.musicEnabled),
                sfxEnabled: booleanOr(candidate.settings.sfxEnabled, defaults.settings.sfxEnabled),
                hapticsEnabled: booleanOr(candidate.settings.hapticsEnabled, defaults.settings.hapticsEnabled),
                reducedMotion: booleanOr(candidate.settings.reducedMotion, defaults.settings.reducedMotion),
                performanceHud: booleanOr(candidate.settings.performanceHud, defaults.settings.performanceHud),
                dailyReminder: booleanOr(candidate.settings.dailyReminder, defaults.settings.dailyReminder),
            },
            progress: {
                controlsSeen: booleanOr(candidate.progress?.controlsSeen, false),
            },
        };
    } catch {
        return null;
    }
}
