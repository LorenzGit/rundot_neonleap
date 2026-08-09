/**
 * NEONLEAP invariant suite.
 *
 * These are the promises the game makes that are cheap to break by accident:
 * the §3 physics constants, the fairness contract's plumbing, fail-closed
 * monetization, honest player copy, safe-area discipline, and release
 * metadata. Gameplay tuning lives in `simulate.ts`; this file guards the
 * contracts around it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const readJson = (path) => JSON.parse(read(path));

const packageJson = readJson("../package.json");
const gameConfig = readJson("../game.config.prod.json");
const shopConfig = readJson("../rundot/shop.config.json");

const html = read("../index.html");
const main = read("../src/main.ts");
const controller = read("../src/ui/controller.ts");
const styles = read("../src/styles/app.css");
const ftue = read("../src/ui/ftue.ts");
const scene = read("../src/game/scene.ts");
const core = read("../src/game/core.ts");
const pixiApp = read("../src/game/pixiApp.ts");
const audioManager = read("../src/audio/audioManager.ts");
const save = read("../src/systems/save.ts");
const commerce = read("../src/systems/commerce.ts");
const monetizationConfig = read("../src/systems/monetization/config.ts");
const rewardedAds = read("../src/systems/rewardedAds.ts");
const interstitialAds = read("../src/systems/interstitialAds.ts");
const notifications = read("../src/systems/notifications.ts");
const simulate = read("./simulate.ts");

/* ------------------------------------------------------------- 1. identity */

assert.equal(packageJson.name, "neonleap");
assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, "package version must be semantic");
assert.match(html, /<title>NEONLEAP<\/title>/, "the document must carry the shipped title");
assert.match(main, /__APP_VERSION__/, "the UI must render the injected package version");
assert.doesNotMatch(
    // Source plus the PLAYER-FACING docs. A stale notices file naming another
    // game is exactly the kind of thing that ships unnoticed. DESIGN.md is
    // exempt on purpose: it records this game's fork lineage and a sibling
    // title's price as a comparable, and both are true.
    `${html}\n${styles}\n${main}\n${controller}\n${scene}\n${core}\n${read("../README.md")}\n${read("../THIRD_PARTY_NOTICES.md")}`,
    /deadstop|DEADSTOP|scrap[-_ ]?shift|SCRAP\/\/SHIFT|Pixel Foundry/i,
    "no scaffold identity may survive in NEONLEAP source or docs",
);
assert.equal(String(gameConfig.orientation).toLowerCase(), "landscape", "RUN metadata must declare landscape");

/* -------------------------------------------------- 2. the physics contract */

// DESIGN.md §3 — these numbers ARE the game. Changing one without re-running
// the balance sweep silently rewrites every gap on the track.
assert.match(core, /JUMP_IMPULSE = 950/, "§3 jump impulse is canon");
assert.match(core, /GRAVITY_RISING_HELD = 1450/, "§3 held gravity is canon");
assert.match(core, /GRAVITY_RISING_RELEASED = 3100/, "§3 released gravity is canon");
assert.match(core, /GRAVITY_FALLING = 2600/, "§3 fall gravity is canon");
assert.match(core, /COYOTE_SECONDS = 0\.09/, "coyote time is canon");
assert.match(core, /JUMP_BUFFER_SECONDS = 0\.12/, "the jump buffer is canon");
assert.match(core, /FIXED_DT = 1 \/ 120/, "the sim must step at a fixed 120 Hz");
assert.match(
    core,
    /while \(this\.accumulator >= FIXED_DT\)/,
    "dt must accumulate into fixed steps, never integrate raw",
);
assert.doesNotMatch(core, /Math\.random\(/, "no wall-clock randomness in the deterministic core");
assert.doesNotMatch(core, /Date\.now\(/, "no wall clock in the deterministic core");

/* ------------------------------------------------ 3. the fairness contract */

assert.match(core, /heldJumpReach/, "the generator must size gaps from the real jump physics");
assert.match(core, /capFraction \* heldJumpReach/, "every gap is capped by the §7 fairness fraction");
assert.match(core, /RUNWAY_LENGTH = 600/, "every run opens on the guaranteed §8 runway");
assert.match(core, /billboardTail/, "billboards must always leave room to land after the clearing leap");
assert.match(core, /x \+ w > roof\.x1 - 140/, "clutter must respect the §8 edge clearance on BOTH edges");
assert.match(simulate, /certifiedDeaths,\s*\n?\s*0,/, "the balance sweep must forbid deaths on certified lines");

/* -------------------------------------------- 4. fail-closed monetization */

assert.match(monetizationConfig, /enabledByDefault: false/, "ad placements must fail closed");
assert.match(commerce, /order\.status !== "fulfilled"/, "an unsettled order must never grant");
assert.match(commerce, /redeemCellOrder/, "consumable grants must route through the idempotent redeemer");
assert.match(save, /redeemedOrderIds/, "the save must remember redeemed order ids");
assert.match(rewardedAds, /granted: true, message: "BACK ON THE PAGE"/, "revive only on confirmed completion");
assert.match(interstitialAds, /neonleap_neon_core/, "NEON CORE must be the entitlement that removes interstitials");
assert.match(save, /cellBonusMultiplier/, "the NEON CORE +25% cell bonus must be centralised");
assert.doesNotMatch(`${controller}\n${main}`, /bucks/i, "player-facing copy never says bucks; prices render as RB");

const itemIds = shopConfig.items.map((item) => item.itemId).sort();
assert.deepEqual(itemIds, ["neonleap_cell_cache", "neonleap_neon_core"], "the shop carries exactly the §11 items");
assert.ok(
    shopConfig.items.every((item) => item.price.type === "bucks"),
    "shop items price in bucks (rendered as RB)",
);

/* ----------------------------------------------------- 5. save discipline */

assert.match(save, /neonleap-save-v1/, "the hosted save key is stable");
assert.doesNotMatch(
    save,
    /\nconst SAVE_KEY = "[^"]*\.[^"]*"/,
    "RUN appStorage keys must not contain a dot (writes fail silently)",
);
assert.match(save, /parseGameSave/, "every load path must go through the sanitising parser");

/* ------------------------------------------------------ 6. UI discipline */

assert.match(styles, /--run-safe-top/, "the HUD must honor RUN safe-area insets");
assert.match(styles, /env\(safe-area-inset-top/, "CSS env() fallbacks must back the host insets");
assert.match(styles, /prefers-reduced-motion/, "reduced motion must also respect the OS setting");
assert.match(controller, /TAP TO JUMP/, "the FTUE tap hint is canon copy");
assert.match(controller, /HOLD FOR HIGHER/, "the FTUE hold hint is canon copy");
assert.match(ftue, /controlsSeen/, "a coached player is never coached again");
assert.match(html, /viewport-fit=cover/, "the page must extend into device cutouts for true fullscreen");
assert.match(controller, /NEW BEST/, "the results screen must stamp a new best");
assert.match(main, /maybeShowResultsInterstitial/, "interstitials only ever run through the results gate");
assert.match(scene, /blendMode = "add"/, "neon needs additive light (sprites, never Graphics)");
assert.match(pixiApp, /preference/, "the renderer must stay WebGPU-first with WebGL fallback");

/* ------------------------------------------------- 6b. instrumentation */

// A cached boot-time permission probe must never GATE a later action: that is
// exactly how a daily reminder ships dead for a whole session.
assert.doesNotMatch(
    notifications,
    /if \(!permissionGranted\) return false;/,
    "the reminder must re-probe and attempt, never gate on a stale cached permission",
);
assert.match(notifications, /await refreshNotificationPermission\(\);/, "the reminder must re-read permission at use");

// Every funnel must advance somewhere other than boot. A funnel that only
// fires during load measures nothing about the game.
for (const [funnel, step] of [
    ["ftue", 3],
    ["ftue", 6],
    ["engagement", null],
    ["purchase", 3],
]) {
    const pattern = step ? new RegExp(`funnelStep\\("${funnel}", ${step}`) : new RegExp(`funnelStep\\("${funnel}"`);
    assert.match(`${main}\n${commerce}`, pattern, `the ${funnel} funnel must advance outside boot`);
}

// The loop, its failure, and its economy all have to report.
for (const event of [
    "run_start",
    "run_end",
    "first_gap_cleared",
    "flow_tier",
    "powerup_taken",
    "upgrade_buy",
    "mission_complete",
    "daily_reward_claim",
]) {
    assert.match(
        `${main}\n${read("../src/systems/missions.ts")}\n${read("../src/systems/dailyRewards.ts")}`,
        new RegExp(`"${event}"`),
        `${event} must be instrumented`,
    );
}
assert.match(main, /cause: runCause/, "run_end must carry the death cause, or failure is unanalysable");
assert.match(main, /analytics\.sessionStart\(/, "sessions must be bounded: start");
assert.match(main, /analytics\.sessionEnd\(/, "sessions must be bounded: end");
assert.match(main, /analytics\.installErrorCapture\(\)/, "runtime errors must reach analytics");
assert.match(main, /analytics\.markTransportReady\(\)/, "pre-transport events must be buffered, never dropped");

/* --------------------------------------------------------- 7. audio + copy */

assert.match(audioManager, /import MUSIC_URL from "\.\/assets\/rooftop-run\.mp3"/, "the owner's score is the music");
assert.match(audioManager, /MUSIC_VOLUME = 0\.2/, "the score sits at 20% under the SFX");
assert.match(audioManager, /noiseBuffer/, "sound effects stay procedural — synthesized, never sampled");
assert.match(notifications, /neonleap-supply-drop/, "the reminder id is NEONLEAP's own");

console.log("invariants ok: identity, physics canon, fairness, fail-closed money, saves, UI, instrumentation, audio");
