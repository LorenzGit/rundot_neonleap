import {
    DAILY_REWARDS,
    type DailyRewardDefinition,
    dailyRewardClaimId,
    dailyRewardIndex,
} from "./dailyRewardsModel.ts";
import { saveSystem } from "./save.ts";
import { formatDailyCountdown, msUntilNextLocalMidnight, serverNow, trustedTimeGate } from "./serverTime.ts";

export { DAILY_REWARDS, type DailyRewardDefinition } from "./dailyRewardsModel.ts";

let claimInFlight = false;

export interface DailyRewardsView {
    rewards: readonly DailyRewardDefinition[];
    currentIndex: number;
    totalClaims: number;
    claimedToday: boolean;
    claimable: boolean;
    authorityLabel: string;
    nextLabel: string;
}

export function dailyRewardsView(): DailyRewardsView {
    const gate = trustedTimeGate();
    const state = saveSystem.get();
    const claimId = gate.day ? dailyRewardClaimId(gate.day) : "";
    const claimedToday = claimId.length > 0 && state.daily.claimIds.includes(claimId);
    return {
        rewards: DAILY_REWARDS,
        currentIndex: dailyRewardIndex(state.daily.totalClaims),
        totalClaims: state.daily.totalClaims,
        claimedToday,
        claimable: gate.ready && !claimedToday && !claimInFlight,
        authorityLabel: gate.label,
        nextLabel: claimedToday
            ? `NEXT DROP IN ${formatDailyCountdown(msUntilNextLocalMidnight(serverNow()))}`
            : "TONIGHT'S DROP IS READY",
    };
}

export async function claimDailyReward(): Promise<{ ok: boolean; message: string }> {
    if (claimInFlight) return { ok: false, message: "CLAIM ALREADY IN PROGRESS" };
    const gate = trustedTimeGate();
    if (!gate.ready || !gate.day) return { ok: false, message: gate.label };
    const before = saveSystem.get();
    const claimId = dailyRewardClaimId(gate.day);
    if (before.daily.claimIds.includes(claimId)) {
        return { ok: false, message: "TONIGHT'S DROP ALREADY CLAIMED" };
    }
    const reward = DAILY_REWARDS[dailyRewardIndex(before.daily.totalClaims)] ?? DAILY_REWARDS[0];
    if (!reward) return { ok: false, message: "NO REWARD CONFIGURED" };
    claimInFlight = true;
    const applied = saveSystem.applyDailyReward({ day: gate.day, cells: reward.cells });
    if (!applied.ok) {
        claimInFlight = false;
        return { ok: false, message: "TONIGHT'S DROP ALREADY CLAIMED" };
    }
    const saved = await saveSystem.flush();
    if (!saved) {
        saveSystem.restore(applied.previous);
        claimInFlight = false;
        return { ok: false, message: "SAVE FAILED · REWARD ROLLED BACK" };
    }
    claimInFlight = false;
    return { ok: true, message: `+${applied.granted} CELLS` };
}
