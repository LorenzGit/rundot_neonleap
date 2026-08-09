/** Stable rewarded/interstitial placement definitions, separate from UI call sites. */

export type AdPlacementType = "rewarded" | "interstitial";
export type SubscriberAdPolicy = "same-as-free" | "skip" | "instant-reward";
export type NoAdFallback = "hide" | "disable-with-message" | "free-grant";

export interface PlacementUnlock {
    minCompletedSessions: number;
    minProgression: number;
    requireValueMoment: boolean;
}

interface BasePlacement {
    id: string;
    displayName: string;
    type: AdPlacementType;
    enabledByDefault: boolean;
    unlock: PlacementUnlock;
    cooldownSeconds: number;
    sessionCap: number;
    dailyCap: number;
    subscriberPolicy: SubscriberAdPolicy;
    noAdFallback: NoAdFallback;
}

export interface RewardedPlacement extends BasePlacement {
    type: "rewarded";
    rewardId: string;
    rewardAmount: number;
}

export interface InterstitialPlacement extends BasePlacement {
    type: "interstitial";
    naturalBreak: string;
    excludeFirstSession: boolean;
    everyNthRun: number;
}

export type MonetizationPlacement = RewardedPlacement | InterstitialPlacement;

export interface PlacementRegistry {
    all(): readonly MonetizationPlacement[];
    get(id: string): MonetizationPlacement | undefined;
    require(id: string): MonetizationPlacement;
}

export function createPlacementRegistry(definitions: readonly MonetizationPlacement[]): PlacementRegistry {
    // ADAPT: define placements from the game's real value moments and natural breaks.
    const byId = new Map<string, MonetizationPlacement>();
    for (const input of definitions) {
        const placement = clonePlacement(input);
        validatePlacement(placement);
        if (byId.has(placement.id)) throw new Error(`Duplicate monetization placement: ${placement.id}`);
        byId.set(placement.id, Object.freeze(placement));
    }

    return {
        all: () => Object.freeze([...byId.values()]),
        get: (id) => byId.get(id),
        require(id) {
            const placement = byId.get(id);
            if (!placement) throw new Error(`Unknown monetization placement: ${id}`);
            return placement;
        },
    };
}

function clonePlacement(input: MonetizationPlacement): MonetizationPlacement {
    return { ...input, unlock: { ...input.unlock } };
}

function validatePlacement(p: MonetizationPlacement): void {
    if (!/^[a-z][a-z0-9_]*$/.test(p.id)) throw new Error(`Invalid placement id: ${p.id}`);
    if (!p.displayName.trim()) throw new Error(`Placement ${p.id} needs a displayName`);
    for (const [name, value] of [
        ["cooldownSeconds", p.cooldownSeconds],
        ["sessionCap", p.sessionCap],
        ["dailyCap", p.dailyCap],
        ["minCompletedSessions", p.unlock.minCompletedSessions],
        ["minProgression", p.unlock.minProgression],
    ] as const) {
        if (!Number.isFinite(value) || value < 0) throw new Error(`${p.id}.${name} must be non-negative`);
    }
    if (p.type === "rewarded" && (!p.rewardId.trim() || p.rewardAmount <= 0)) {
        throw new Error(`Rewarded placement ${p.id} needs a positive named reward`);
    }
    if (p.type === "interstitial" && !p.naturalBreak.trim()) {
        throw new Error(`Interstitial ${p.id} needs a naturalBreak`);
    }
    if (p.type === "interstitial" && (!Number.isInteger(p.everyNthRun) || p.everyNthRun < 1)) {
        throw new Error(`Interstitial ${p.id} needs a positive everyNthRun`);
    }
}
