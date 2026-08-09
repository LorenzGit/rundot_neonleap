// Pure mission model (DESIGN.md §10): templates and the deterministic daily
// deal. No save, SDK, or DOM imports — `npm run test` exercises this directly.

import { NoiseRandom } from "../game/noiseRandom.ts";

export type MissionKind = "distance" | "cells" | "nearMiss" | "smash" | "tier";

export interface MissionSlotModel {
    id: string;
    kind: string;
    target: number;
    reward: number;
    progress: number;
    claimed: boolean;
}

export interface MissionBoardModel {
    dateKey: string;
    slots: MissionSlotModel[];
}

interface MissionTemplate {
    kind: MissionKind;
    /** Inclusive target range the date seed rolls inside. */
    min: number;
    max: number;
    /** Reward scales linearly across the target range (§10: 40–120 cells). */
    rewardMin: number;
    rewardMax: number;
    label: (target: number) => string;
}

export const MISSION_TEMPLATES: readonly MissionTemplate[] = [
    {
        kind: "distance",
        min: 800,
        max: 2600,
        rewardMin: 50,
        rewardMax: 120,
        label: (target) => `RUN ${target} M IN ONE RUN`,
    },
    {
        kind: "cells",
        min: 25,
        max: 90,
        rewardMin: 40,
        rewardMax: 100,
        label: (target) => `COLLECT ${target} CELLS IN ONE RUN`,
    },
    {
        kind: "nearMiss",
        min: 3,
        max: 12,
        rewardMin: 40,
        rewardMax: 110,
        label: (target) => `NEAR-MISS ${target} TIMES IN ONE RUN`,
    },
    {
        kind: "smash",
        min: 4,
        max: 20,
        rewardMin: 50,
        rewardMax: 120,
        label: (target) => `SMASH ${target} OBSTACLES IN ONE RUN`,
    },
    {
        kind: "tier",
        min: 3,
        max: 9,
        rewardMin: 50,
        rewardMax: 120,
        label: (target) => `REACH SPEED TIER ${target}`,
    },
];

export function seedForDay(day: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < day.length; index += 1) {
        hash = Math.imul(hash ^ day.charCodeAt(index), 0x0100_0193) >>> 0;
    }
    return hash >>> 0;
}

/** Deals the day's three missions: distinct templates, seeded by the date. */
export function dealMissions(day: string): MissionBoardModel {
    const rng = new NoiseRandom(seedForDay(day), 0);
    const deck = [...MISSION_TEMPLATES.keys()];
    const slots: MissionSlotModel[] = [];
    for (let slot = 0; slot < 3 && deck.length > 0; slot += 1) {
        const pick = rng.int(0, deck.length, slot);
        const templateIndex = deck.splice(pick, 1)[0] ?? 0;
        const template = MISSION_TEMPLATES[templateIndex];
        if (!template) continue;
        const roll = rng.nextDouble(slot + 10);
        const target = Math.round(template.min + (template.max - template.min) * roll);
        const reward = Math.round(template.rewardMin + (template.rewardMax - template.rewardMin) * roll);
        slots.push({
            id: `${day}:${template.kind}`,
            kind: template.kind,
            target,
            reward,
            progress: 0,
            claimed: false,
        });
    }
    return { dateKey: day, slots };
}

export interface RunMissionSummary {
    distance: number;
    cells: number;
    nearMisses: number;
    smashes: number;
    tier: number;
}

/** The single-run value a mission of this kind measures. */
export function missionValue(kind: string, summary: RunMissionSummary): number {
    return kind === "distance"
        ? summary.distance
        : kind === "cells"
          ? summary.cells
          : kind === "nearMiss"
            ? summary.nearMisses
            : kind === "smash"
              ? summary.smashes
              : summary.tier;
}
