export interface DailyRewardDefinition {
    day: number;
    cells: number;
    label: string;
}

/**
 * The nightly supply drop (DESIGN.md §10): seven escalating cell payouts on a
 * forgiving cycle — missing a day never resets earned progress. Day 7 covers
 * most of the second Upgrade Bay level (140 cells).
 */
export const DAILY_REWARDS: readonly DailyRewardDefinition[] = [
    { day: 1, cells: 30, label: "30 CELLS" },
    { day: 2, cells: 40, label: "40 CELLS" },
    { day: 3, cells: 55, label: "55 CELLS" },
    { day: 4, cells: 70, label: "70 CELLS" },
    { day: 5, cells: 90, label: "90 CELLS" },
    { day: 6, cells: 110, label: "110 CELLS" },
    { day: 7, cells: 200, label: "200 CELLS" },
] as const;

export function dailyRewardIndex(totalClaims: number): number {
    return Math.max(0, Math.floor(totalClaims)) % DAILY_REWARDS.length;
}

export function dailyRewardClaimId(day: string): string {
    return `daily-reward:${day}`;
}

export function dailyRewardState(
    totalClaims: number,
    claimIds: readonly string[],
    day: string,
): {
    currentIndex: number;
    claimedToday: boolean;
} {
    return {
        currentIndex: dailyRewardIndex(totalClaims),
        claimedToday: claimIds.includes(dailyRewardClaimId(day)),
    };
}
