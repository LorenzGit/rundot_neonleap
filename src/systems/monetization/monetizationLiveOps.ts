/** Fail-closed monetization controls. Feed with the host's current LiveOps snapshot. */

export interface PlacementLiveOps {
    enabled?: boolean;
    cooldownSeconds?: number;
    sessionCap?: number;
    dailyCap?: number;
    rewardMultiplier?: number;
    everyNthRun?: number;
}

export interface MonetizationLiveOpsInput {
    enabled?: boolean;
    privateTestMode?: boolean;
    purchasesEnabled?: boolean;
    rewardedAdsEnabled?: boolean;
    interstitialAdsEnabled?: boolean;
    placements?: Record<string, PlacementLiveOps>;
    products?: Record<string, { enabled?: boolean }>;
}

export interface MonetizationLiveOps {
    enabled: boolean;
    privateTestMode: boolean;
    purchasesEnabled: boolean;
    rewardedAdsEnabled: boolean;
    interstitialAdsEnabled: boolean;
    placements: Record<string, Required<PlacementLiveOps>>;
    products: Record<string, { enabled: boolean }>;
}

const MAX_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
const MAX_CAP = 1_000;
const MAX_REWARD_MULTIPLIER = 10;

export function normalizeMonetizationLiveOps(input: MonetizationLiveOpsInput | null | undefined): MonetizationLiveOps {
    // Missing/malformed remote config fails closed. Enable deliberately after validation.
    const enabled = input?.enabled === true;
    const placements: MonetizationLiveOps["placements"] = {};
    const products: MonetizationLiveOps["products"] = {};

    for (const [id, value] of Object.entries(input?.placements ?? {})) {
        placements[id] = {
            enabled: enabled && value?.enabled === true,
            cooldownSeconds: bounded(value?.cooldownSeconds, 0, MAX_COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS),
            sessionCap: bounded(value?.sessionCap, 0, MAX_CAP, 0),
            dailyCap: bounded(value?.dailyCap, 0, MAX_CAP, 0),
            rewardMultiplier: bounded(value?.rewardMultiplier, 0, MAX_REWARD_MULTIPLIER, 1),
            everyNthRun: bounded(value?.everyNthRun, 1, MAX_CAP, 1),
        };
    }

    for (const [id, value] of Object.entries(input?.products ?? {})) {
        products[id] = { enabled: enabled && value?.enabled === true };
    }

    return {
        enabled,
        privateTestMode: enabled && input?.privateTestMode === true,
        purchasesEnabled: enabled && input?.purchasesEnabled === true,
        rewardedAdsEnabled: enabled && input?.rewardedAdsEnabled === true,
        interstitialAdsEnabled: enabled && input?.interstitialAdsEnabled === true,
        placements,
        products,
    };
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
