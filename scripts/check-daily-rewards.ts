import assert from "node:assert/strict";
import {
    DAILY_REWARDS,
    dailyRewardClaimId,
    dailyRewardIndex,
    dailyRewardState,
} from "../src/systems/dailyRewardsModel.ts";

assert.equal(DAILY_REWARDS.length, 7);
assert.equal(dailyRewardIndex(0), 0);
assert.equal(dailyRewardIndex(6), 6);
assert.equal(dailyRewardIndex(7), 0, "track should repeat after seven successful claims");

const afterTwoClaims = dailyRewardState(
    2,
    [dailyRewardClaimId("2026-07-20"), dailyRewardClaimId("2026-07-21")],
    "2026-07-24",
);
assert.equal(afterTwoClaims.currentIndex, 2, "missing days must not reset earned progress");
assert.equal(afterTwoClaims.claimedToday, false);

const duplicate = dailyRewardState(2, [dailyRewardClaimId("2026-07-24")], "2026-07-24");
assert.equal(duplicate.claimedToday, true, "same-day duplicate claim must be detected");
assert.equal(DAILY_REWARDS[2]?.cells, 55);
assert.equal(DAILY_REWARDS[6]?.cells, 200, "night seven must be the anchor reward");

console.log("daily rewards check ok: seven-day loop, missed-day continuity, duplicate guard");
