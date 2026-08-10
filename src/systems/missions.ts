// Daily missions runtime: persistence, progress, and claims around the pure
// model in missionsModel.ts. Server-time gated like the supply drop.

import { recordAnalytics } from "../sdk/runSdk.ts";
import { dealMissions, MISSION_TEMPLATES, type MissionKind, missionValue } from "./missionsModel.ts";
import { type MissionSlot, type MissionState, saveSystem } from "./save.ts";
import { trustedTimeGate } from "./serverTime.ts";

export type { MissionKind } from "./missionsModel.ts";

export interface MissionView {
    id: string;
    kind: MissionKind;
    label: string;
    target: number;
    progress: number;
    reward: number;
    complete: boolean;
    claimed: boolean;
}

/** Ensures today's board is dealt; keeps an in-progress board for the same day. */
export function refreshMissions(): MissionState {
    const gate = trustedTimeGate();
    const current = saveSystem.get().missions;
    if (!gate.ready || !gate.day) return current;
    if (current.dateKey === gate.day && current.slots.length > 0) return current;
    const dealt = dealMissions(gate.day);
    saveSystem.setMissions(dealt);
    void saveSystem.flush();
    return dealt;
}

export interface RunMissionSummary {
    distance: number;
    cells: number;
    nearMisses: number;
    smashes: number;
    tier: number;
}

/** Best-of-run progress: each mission tracks the strongest single run. */
export function recordRunForMissions(summary: RunMissionSummary): MissionView[] {
    const board = refreshMissions();
    if (board.slots.length === 0) return [];
    const completedNow: MissionView[] = [];
    const next: MissionState = {
        dateKey: board.dateKey,
        slots: board.slots.map((slot) => {
            const value = missionValue(slot.kind, summary);
            const progress = Math.min(slot.target, Math.max(slot.progress, Math.floor(value)));
            if (progress >= slot.target && slot.progress < slot.target && !slot.claimed) {
                completedNow.push(toView({ ...slot, progress }));
                recordAnalytics("mission_complete", { missionId: slot.id, kind: slot.kind, target: slot.target });
            }
            return { ...slot, progress };
        }),
    };
    saveSystem.setMissions(next);
    return completedNow;
}

function toView(slot: MissionSlot): MissionView {
    const template = MISSION_TEMPLATES.find((entry) => entry.kind === slot.kind);
    return {
        id: slot.id,
        kind: slot.kind as MissionKind,
        label: template ? template.label(slot.target) : `${slot.kind} ${slot.target}`,
        target: slot.target,
        progress: slot.progress,
        reward: slot.reward,
        complete: slot.progress >= slot.target,
        claimed: slot.claimed,
    };
}

export function missionViews(): MissionView[] {
    return refreshMissions().slots.map(toView);
}

/** A completed, unclaimed mission badges the menu button (§10). */
export function unclaimedMissionCount(): number {
    return missionViews().filter((mission) => mission.complete && !mission.claimed).length;
}

export async function claimMission(missionId: string): Promise<{ ok: boolean; message: string; granted: number }> {
    const board = saveSystem.get().missions;
    const slot = board.slots.find((entry) => entry.id === missionId);
    if (!slot) return { ok: false, message: "MISSION NOT ON TONIGHT'S BOARD", granted: 0 };
    if (slot.claimed) return { ok: false, message: "ALREADY CLAIMED", granted: 0 };
    if (slot.progress < slot.target) return { ok: false, message: "NOT COMPLETE YET", granted: 0 };
    const granted = saveSystem.grantCells(slot.reward);
    saveSystem.setMissions({
        dateKey: board.dateKey,
        slots: board.slots.map((entry) => (entry.id === missionId ? { ...entry, claimed: true } : entry)),
    });
    if (!(await saveSystem.flush())) {
        // Delta revert, not a snapshot restore: cells earned elsewhere while
        // the flush was in flight must survive the rollback.
        saveSystem.revertMissionClaim({ missionId, granted });
        return { ok: false, message: "SAVE FAILED · TRY AGAIN", granted: 0 };
    }
    recordAnalytics("mission_claimed", { missionId, reward: slot.reward, granted });
    return { ok: true, message: `+${granted} CELLS`, granted };
}
