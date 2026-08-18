import { audioManager } from "./audio/audioManager.ts";
import { RunnerCore, type RunnerEvent, type RunnerSnapshot, type UpgradeId } from "./game/core.ts";
import { GameScene } from "./game/scene.ts";
import { installBrowserQaContract } from "./qa/browserContract.ts";
import {
    bindRunSafeArea,
    initSdk,
    recordAnalytics,
    refreshRunCapabilities,
    registerLifecycles,
    requestHostExit,
    triggerHaptic,
    showContextualLikePrompt,
} from "./sdk/runSdk.ts";
import { analytics } from "./systems/analytics/analyticsConfig.ts";
import {
    type CommerceProductId,
    neonCoreOwned,
    productCommerceView,
    purchaseProduct,
    reconcilePendingPurchase,
    refreshCommerce,
} from "./systems/commerce.ts";
import { claimDailyReward, dailyRewardsView } from "./systems/dailyRewards.ts";
import {
    initializeInterstitialAdsSession,
    maybeShowResultsInterstitial,
    refreshInterstitialAdAvailability,
} from "./systems/interstitialAds.ts";
import { beginLeaderboardRun, loadLeaderboard, submitRun } from "./systems/leaderboard.ts";
import {
    claimMission,
    missionViews,
    recordRunForMissions,
    refreshMissions,
    unclaimedMissionCount,
} from "./systems/missions.ts";
import { refreshMonetizationRuntime } from "./systems/monetization/runtime.ts";
import {
    clearPendingReminder,
    refreshNotificationPermission,
    reminderView,
    setDailyReminderEnabled,
    syncDailyReminder,
} from "./systems/notifications.ts";
import {
    beginSecondWindRun,
    claimSecondWind,
    initializeRewardedAdsSession,
    refreshRewardedAdAvailability,
    secondWindView,
} from "./systems/rewardedAds.ts";
import {
    type GameSettings,
    type SaveSource,
    saveSystem,
    UPGRADE_IDS,
    UPGRADE_LEVEL_CAP,
    upgradeCost,
} from "./systems/save.ts";
import { refreshServerTime } from "./systems/serverTime.ts";
import { UiController, type ResultsSummary, type UpgradeRowView } from "./ui/controller.ts";
import { Ftue } from "./ui/ftue.ts";
import { PerformanceHud } from "./ui/performanceHud.ts";
import "./styles/app.css";

import {
    refreshNotificationPermission as refreshReturnReminderPermission,
    resolveReturnLaunch,
    returnReminders,
} from "./systems/retention/retentionConfig";

// Fired at module scope, before any await: this is the only row a player who
// closes the tab mid-load will ever produce. Emissions here are buffered until
// markTransportReady() below, once the SDK transport exists.
analytics.installErrorCapture();
// The browser's own end-of-session signals. onQuit alone produced two
// session_end events across the whole fleet in thirty days, because it
// needs a clean host quit and players just close the tab.
analytics.installSessionEndCapture();
// Retention: arm the 24/48/72h return cadence and attribute a
// notification-driven launch. Both are fire-and-forget — a host without
// notification support must not delay the first playable frame.
void refreshReturnReminderPermission().then(() => returnReminders.refreshAll());
void resolveReturnLaunch();
analytics.funnelStep("load", 1);

const core = new RunnerCore({ seed: 1, upgrades: saveSystem.get().upgrades });
core.pause();
const performanceHud = new PerformanceHud();
let scene: GameScene;
let ui: UiController;
let saveSource: SaveSource = "defaults";
let lastHudUpdate = 0;
let lastPhase: RunnerSnapshot["phase"] = "paused";
let runBanked = false;
let runKey = 0;
let runRevives = 0;
let runCause: "fall" | "billboard" | "ended" = "ended";
let maxFlowThisRun = 1;
let firstGapCleared = false;
let firstJumpTaken = false;
let firstPowerupTaken = false;
let lastBankedSummary: ResultsSummary | null = null;
let qaSimulationFrozen = false;
/**
 * Presentation-side time effects (DESIGN §12): stumble freezes the world for
 * 70 ms, a near-miss beats at 0.35× for 90 ms. The renderer keeps running, so
 * both read as a held breath rather than a dropped frame.
 */
let hitStop = 0;
let slowBeat = 0;
/** Real seconds after death before the results sheet slides in. */
let deathHold = 0;
let ftue = new Ftue(true);

function onAdPresentation(visible: boolean): void {
    audioManager.setPaused(visible);
    ui.handleAdPresentation(visible);
}

function updateBoot(progress: number, copy: string): void {
    const fill = document.getElementById("boot-fill");
    const label = document.getElementById("boot-copy");
    if (fill) fill.style.width = `${Math.max(4, Math.min(100, progress))}%`;
    if (label) label.textContent = copy;
}

const BOOT_FAILURE_KEY = "neonleap:boot-failure:v1";

/** Shape the HTML boot watchdog publishes on `window.__boot`. */
interface BootWatchdogState {
    startedAt: number;
    /** Set once the cover has been up longer than the slow threshold. */
    slowMs: number | null;
    outcome: string | null;
    settled: boolean;
    timer?: number;
}

/**
 * Report what the boot watchdog observed.
 *
 * Two things get reported here, and neither could be reported when it happened:
 *
 *  - A boot that FAILED had no analytics module to report with — that was the
 *    whole failure. The watchdog wrote it to localStorage instead, so the next
 *    successful boot carries it. `elapsed_ms` is from the failed session.
 *  - A boot that was merely SLOW succeeded, so it reports in-session.
 *
 * Call once, after the analytics transport is ready.
 */
function reportBootOutcome(): void {
    const boot = (window as unknown as { __boot?: BootWatchdogState }).__boot;
    try {
        const raw = window.localStorage.getItem(BOOT_FAILURE_KEY);
        if (raw) {
            window.localStorage.removeItem(BOOT_FAILURE_KEY);
            const record = JSON.parse(raw) as { reason?: string; elapsed_ms?: number; at?: string };
            analytics.trackError("boot_failure", new Error(record.reason ?? "unknown"), {
                reason: record.reason ?? "unknown",
                elapsed_ms: record.elapsed_ms ?? 0,
                failed_at: record.at ?? "",
                recovered: true,
            });
        }
    } catch {
        // A boot report must never be the reason a boot fails.
    }
    if (boot?.slowMs) {
        analytics.event("boot_slow", {
            threshold_ms: boot.slowMs,
            elapsed_ms: Math.max(0, Date.now() - boot.startedAt),
        });
    }
}

function liftBootCover(): void {
    // The game owns the screen now; the HTML watchdog must not fire behind it.
    const watchdog = (window as unknown as { __bootWatchdog?: number }).__bootWatchdog;
    if (watchdog !== undefined) window.clearTimeout(watchdog);
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const cover = document.getElementById("boot-cover");
            if (!cover) return;
            cover.classList.add("hidden");
            window.setTimeout(() => cover.remove(), 320);
        });
    });
}

function haptic(style: Parameters<typeof triggerHaptic>[0]): void {
    if (saveSystem.get().settings.hapticsEnabled) void triggerHaptic(style);
}

/* ------------------------------------------------------------------ run flow */

function startRun(): void {
    runKey += 1;
    hitStop = 0;
    slowBeat = 0;
    deathHold = 0;
    runBanked = false;
    runRevives = 0;
    runCause = "ended";
    maxFlowThisRun = 1;
    lastBankedSummary = null;
    qaSimulationFrozen = false;
    const saved = saveSystem.get();
    const seed = (0x9e0_47c5 ^ (saved.records.totalRuns * 7919 + runKey * 104_729)) >>> 0;
    core.reset({ seed, upgrades: saved.upgrades });
    lastPhase = "running";
    beginSecondWindRun(runKey);
    beginLeaderboardRun(runKey);
    ftue = new Ftue(saved.progress.controlsSeen);
    // Canonical onboarding beat. ftue_completed already fires in finishCoach();
    // kept out of Ftue itself so that module stays free of host imports.
    if (!saved.progress.controlsSeen) analytics.event("ftue_started", { coach: "controls" });
    scene.setMode("run");
    audioManager.setMode("run");
    audioManager.setTier(0);
    audioManager.setFocus(false);
    audioManager.setPaused(false);
    ui.showRunning();
    ui.showCoach(null);
    recordAnalytics("run_started", {
        inputMode: matchMedia("(pointer: coarse)").matches ? "touch" : "keyboard",
        headStart: saved.upgrades.headStart,
        seed,
    });
    // Steps 2 and 7 share this call site; the once-ever marks make the second
    // press register as "came back for another run" without extra bookkeeping.
    analytics.funnelStep("ftue", saved.records.totalRuns === 0 ? 2 : 7);
}

function pauseRun(): void {
    const phase = core.snapshot().phase;
    if (phase === "running") {
        core.pause();
        ui.showPause();
        audioManager.setPaused(true);
        void saveSystem.flush();
    } else if (phase === "paused" && ui.currentScreen() === "pause") {
        resumeRun();
    }
}

function resumeRun(): void {
    if (core.snapshot().phase !== "paused" || ui.currentScreen() !== "pause") return;
    core.resume();
    ui.showRunning();
    audioManager.setPaused(false);
}

function backToMenu(): void {
    core.pause();
    lastPhase = "paused";
    scene.setMode("menu");
    audioManager.setMode("menu");
    audioManager.setPaused(false);
    ui.showMenu();
}

function applySettings(settings: GameSettings): void {
    saveSystem.updateSettings(settings);
    audioManager.applySettings(settings);
    performanceHud.setEnabled(settings.performanceHud);
    scene.setReducedMotion(settings.reducedMotion);
    document.documentElement.dataset.reducedMotion = String(settings.reducedMotion);
    recordAnalytics("setting_changed", {
        music: settings.musicEnabled,
        sfx: settings.sfxEnabled,
        haptics: settings.hapticsEnabled,
        reducedMotion: settings.reducedMotion,
    });
    void saveSystem.flush();
}

async function refreshMonetization(): Promise<void> {
    await refreshMonetizationRuntime();
    await Promise.all([refreshCommerce(), refreshRewardedAdAvailability(), refreshInterstitialAdAvailability()]);
}

/* ------------------------------------------------------------------- results */

function bankRun(snapshot: RunnerSnapshot): ResultsSummary {
    const before = saveSystem.get().records;
    const newBest = snapshot.distance > before.bestDistance;
    const summary: ResultsSummary = {
        distance: snapshot.distance,
        score: snapshot.score,
        cellsEarned: 0,
        nearMisses: snapshot.nearMisses,
        smashes: snapshot.smashes,
        maxFlow: maxFlowThisRun,
        bestDistance: Math.max(before.bestDistance, snapshot.distance),
        newBest,
        cause: runCause,
        revives: runRevives,
    };
    if (runBanked) {
        // A revived-then-finished run re-banks only the delta run stats; the
        // simple, honest model is: bank once per life, keep the first summary.
        return lastBankedSummary ?? summary;
    }
    runBanked = true;
    summary.cellsEarned = saveSystem.recordRun({
        distance: snapshot.distance,
        score: snapshot.score,
        cells: snapshot.cellsThisRun,
        nearMisses: snapshot.nearMisses,
        smashes: snapshot.smashes,
        stumbles: snapshot.stumbles,
        died: runCause !== "ended",
        revives: runRevives,
    });
    const completed = recordRunForMissions({
        distance: snapshot.distance,
        cells: snapshot.cellsThisRun,
        nearMisses: snapshot.nearMisses,
        smashes: snapshot.smashes,
        tier: snapshot.speedTier,
    });
    for (const mission of completed) {
        ui.milestone("MISSION COMPLETE", mission.label);
        audioManager.play("fanfare");
    }
    void saveSystem.flush();
    // Ask for the like on a win. The wrapper owns the policy (3 wins, once ever).
    void showContextualLikePrompt();
    recordAnalytics("run_completed", {
        distance: snapshot.distance,
        score: snapshot.score,
        cells: snapshot.cellsThisRun,
        tier: snapshot.speedTier,
        stumbles: snapshot.stumbles,
        nearMisses: snapshot.nearMisses,
        smashes: snapshot.smashes,
        cause: runCause,
        revives: runRevives,
        elapsed: Math.round(snapshot.time),
    });
    analytics.funnelStep("ftue", 6, { distance: snapshot.distance });
    analytics.funnelStep("engagement", saveSystem.get().records.totalRuns, { distance: snapshot.distance });
    lastBankedSummary = summary;
    // Ranked after banking, so "is this a personal best?" reads the record the
    // run just set. Fire-and-forget: the board must never delay the results.
    void submitRun({
        distance: snapshot.distance,
        durationSeconds: snapshot.time,
        score: snapshot.score,
        cells: snapshot.cellsThisRun,
        tier: snapshot.speedTier,
    }).then((outcome) => {
        if (outcome.status === "submitted" && outcome.rank !== null) {
            ui.milestone(`RANK #${outcome.rank}`, "ON THE BOARD");
        }
    });
    return summary;
}

function showResults(snapshot: RunnerSnapshot): void {
    const summary = bankRun(snapshot);
    ui.showResults(summary);
    ui.refreshMeta();
    audioManager.setMode("menu");
}

async function exitResults(destination: "retry" | "menu", rewardedInteracted: boolean): Promise<void> {
    recordAnalytics("results_exit_tapped", { destination, rewardedInteracted });
    await maybeShowResultsInterstitial(rewardedInteracted, onAdPresentation);
    if (destination === "retry") startRun();
    else backToMenu();
}

/* -------------------------------------------------------------------- events */

function handleEvent(event: RunnerEvent, snapshot: RunnerSnapshot): void {
    scene.handleEvent(event, snapshot);
    switch (event.type) {
        case "jump":
            audioManager.play("jump");
            if (!firstJumpTaken) {
                firstJumpTaken = true;
                analytics.funnelStep("ftue", 3);
            }
            break;
        case "doubleJump":
            audioManager.play("double_jump");
            haptic("light");
            break;
        case "land":
            audioManager.play("land", event.impact / 1400);
            // Past the 600 u runway, so this landing crossed a real gap: the
            // first "I get it" beat. An event, not a funnel step — it races
            // the coach finishing and would scramble step ordering.
            if (!firstGapCleared && snapshot.distance > 60) {
                firstGapCleared = true;
                recordAnalytics("first_gap_cleared", { distance: snapshot.distance });
            }
            break;
        case "edgeSave":
            audioManager.play("edge_save");
            haptic("light");
            break;
        case "pickup":
            audioManager.play("pickup", event.chain);
            break;
        case "nearMiss":
            audioManager.play("near_miss");
            haptic("light");
            slowBeat = 0.09;
            break;
        case "stumble":
            audioManager.play("stumble");
            haptic("medium");
            hitStop = Math.max(hitStop, 0.07);
            break;
        case "smash":
            audioManager.play(event.billboard ? "billboard_smash" : "smash");
            haptic(event.billboard ? "heavy" : "medium");
            hitStop = Math.max(hitStop, event.billboard ? 0.05 : 0.03);
            break;
        case "powerupStart":
        case "powerupSwap":
            audioManager.play("powerup");
            haptic("success");
            if (!firstPowerupTaken) {
                firstPowerupTaken = true;
                analytics.funnelStep("ftue", 5);
            }
            recordAnalytics("powerup_taken", { kind: event.type === "powerupSwap" ? event.to : event.kind });
            break;
        case "powerupEnd":
            break;
        case "flowTier":
            maxFlowThisRun = Math.max(maxFlowThisRun, event.tier);
            audioManager.play("flow_up");
            haptic("success");
            recordAnalytics("flow_tier", { tier: event.tier });
            break;
        case "speedTier":
            audioManager.setTier(event.tier);
            break;
        case "death":
            runCause = event.cause;
            audioManager.play("death");
            haptic("error");
            hitStop = Math.max(hitStop, 0.12);
            deathHold = 1.0;
            break;
        case "revive":
            audioManager.play("reward");
            haptic("success");
            ui.milestone("SECOND WIND", "REBOOTED AT 60% SPEED");
            break;
    }
}

/* --------------------------------------------------------------------- frame */

/**
 * Blocking sheets sit over a blurred backdrop, so the city behind them is
 * barely visible — but it was still being simulated and composited at full
 * rate, on top of the sheet's own `backdrop-filter`, which is the most
 * expensive thing the UI does. Halve the frame rate whenever one is open.
 * The menu is deliberately excluded: its live city is the first impression.
 */
const SHEET_FPS = 30;
let throttledFor: string | null = null;

function applyFrameBudget(): void {
    const screen = ui.currentScreen();
    if (screen === throttledFor) return;
    throttledFor = screen;
    const blocking = screen !== "hud" && screen !== "menu";
    scene.app.ticker.maxFPS = blocking ? SHEET_FPS : 0;
}

function frame(): void {
    applyFrameBudget();
    const delta = Math.min(0.05, scene.app.ticker.deltaMS / 1000);
    const profiling = performanceHud.isEnabled();
    const simulationStarted = profiling ? performance.now() : 0;

    if (!qaSimulationFrozen) {
        if (hitStop > 0) {
            hitStop = Math.max(0, hitStop - delta);
        } else if (slowBeat > 0) {
            slowBeat = Math.max(0, slowBeat - delta);
            core.update(delta * 0.35);
        } else {
            core.update(delta);
        }
    }
    const snapshot = core.snapshot();
    const events = core.drainEvents();
    for (const event of events) handleEvent(event, snapshot);

    // FTUE hints ride the live run and dissolve on demonstration.
    if (snapshot.phase === "running") {
        const hint = ftue.observe(snapshot, events, delta);
        ui.showCoach(hint);
        if (ftue.isComplete() && !saveSystem.get().progress.controlsSeen) {
            saveSystem.markControlsSeen();
            void saveSystem.flush();
            recordAnalytics("ftue_completed");
            analytics.funnelStep("ftue", 4);
        }
        audioManager.setFocus(snapshot.power?.kind === "focus");
    }

    const renderStarted = profiling ? performance.now() : 0;
    scene.render(snapshot, delta);
    const hudStarted = profiling ? performance.now() : 0;

    if (performance.now() - lastHudUpdate > 70) {
        ui.updateHud(snapshot);
        lastHudUpdate = performance.now();
    }

    // Phase transitions. Death lingers for the tumble before results slide in.
    if (snapshot.phase === "dead") {
        if (lastPhase !== "dead") {
            lastPhase = "dead";
            audioManager.setFocus(false);
        }
        if (deathHold > 0) {
            deathHold -= delta;
            if (deathHold <= 0 && ui.currentScreen() !== "results") showResults(snapshot);
        }
    } else if (snapshot.phase !== lastPhase) {
        lastPhase = snapshot.phase;
    }

    if (profiling) {
        const finished = performance.now();
        performanceHud.recordFrame({
            frameMs: scene.app.ticker.deltaMS,
            simulationMs: renderStarted - simulationStarted,
            renderMs: hudStarted - renderStarted,
            hudMs: finished - hudStarted,
        });
    }
}

/* ---------------------------------------------------------------------- boot */

function upgradeRows(): UpgradeRowView[] {
    const saved = saveSystem.get();
    return UPGRADE_IDS.map((id: UpgradeId) => {
        const level = saved.upgrades[id];
        const cost = upgradeCost(level);
        return {
            id,
            name: id,
            description: "",
            level,
            cap: UPGRADE_LEVEL_CAP,
            cost,
            affordable: cost !== null && saved.wallet.cells >= cost,
        };
    });
}

async function boot(): Promise<void> {
    updateBoot(12, "LINKING RUN SYSTEMS");
    await initSdk();
    analytics.markTransportReady();
    analytics.funnelStep("load", 2);
    bindRunSafeArea();

    updateBoot(30, "READING THE GRID");
    saveSource = await saveSystem.load();
    analytics.funnelStep("load", 3);
    const saved = saveSystem.get();
    initializeRewardedAdsSession();
    initializeInterstitialAdsSession();
    await Promise.all([refreshServerTime(), refreshMonetizationRuntime()]);
    await Promise.all([refreshCommerce(), refreshRewardedAdAvailability(), refreshInterstitialAdAvailability()]);
    await reconcilePendingPurchase();
    refreshMissions();
    // The player is here, so any pending nudge has done its job. Re-arm from
    // the current clock rather than leaving a stale one queued.
    await refreshNotificationPermission();
    await clearPendingReminder();
    void syncDailyReminder();
    audioManager.applySettings(saved.settings);
    audioManager.preloadMusic();
    audioManager.bindUnlock();
    document.documentElement.dataset.reducedMotion = String(saved.settings.reducedMotion);
    performanceHud.setEnabled(saved.settings.performanceHud);

    updateBoot(56, "RAISING THE SKYLINE");
    const host = document.getElementById("scene-host");
    if (!host) throw new Error("Missing #scene-host");
    scene = await GameScene.create(host);
    scene.setReducedMotion(saved.settings.reducedMotion);
    scene.setIonTrail(neonCoreOwned());
    scene.setMode("menu");
    scene.render(core.snapshot(), 0);

    updateBoot(84, "CHARGING CELLS");
    ui = new UiController(
        saved.settings,
        {
            onPlay: startRun,
            onRetry: (rewardedInteracted) => {
                recordAnalytics("retry_tapped");
                void exitResults("retry", rewardedInteracted);
            },
            onMenu: (rewardedInteracted) => void exitResults("menu", rewardedInteracted),
            onPause: pauseRun,
            onResume: resumeRun,
            onEndRun: () => {
                // Ending from pause banks what the run earned so far.
                runCause = "ended";
                showResults(core.snapshot());
            },
            onHeld: (held) => core.setHeld(held),
            onSettingsChanged: applySettings,
            onDailyReminderChanged: async (enabled) => {
                await setDailyReminderEnabled(enabled);
                return reminderView().label;
            },
            onReplayTutorial: () => {
                saveSystem.resetControlsSeen();
                void saveSystem.flush();
                recordAnalytics("ftue_replay_requested");
            },
            onBuyUpgrade: (id) => {
                const next = saveSystem.buyUpgrade(id);
                if (next === null) return "NOT ENOUGH CELLS YET";
                void saveSystem.flush();
                audioManager.play("reward");
                haptic("success");
                recordAnalytics("upgrade_buy", { upgradeId: id, level: next });
                return `${id.toUpperCase()} LEVEL ${next}`;
            },
            onClaimMission: async (missionId) => {
                const outcome = await claimMission(missionId);
                if (outcome.ok) {
                    audioManager.play("fanfare");
                    haptic("success");
                }
                return outcome.message;
            },
            onClaimDaily: async () => {
                const result = await claimDailyReward();
                recordAnalytics("daily_reward_claim", { ok: result.ok, reward: result.message });
                // The 24h reminder promises this reward; leaving it queued pings
                // the player about something they just claimed.
                void returnReminders.cancel("d1");
                if (result.ok) {
                    audioManager.play("reward");
                    haptic("success");
                    void syncDailyReminder();
                }
                return result.message;
            },
            onPurchaseProduct: async (productId: CommerceProductId) => {
                analytics.funnelStep("purchase", 2);
                recordAnalytics("offer_clicked", { productId, placement: "upgrade_bay" });
                const outcome = await purchaseProduct(productId, "upgrade_bay");
                if (!outcome) return "PURCHASE CURRENTLY UNAVAILABLE";
                await refreshCommerce();
                scene.setIonTrail(neonCoreOwned());
                if (outcome.status === "confirmed") {
                    audioManager.play("reward");
                    haptic("success");
                    ui.refreshMeta();
                    if (productId === "cell_cache") return "VERIFIED · 500 CELLS ADDED";
                    return "VERIFIED · NEON CORE ONLINE";
                }
                if (outcome.status === "cancelled") return "PURCHASE CANCELLED";
                if (outcome.status === "failed") return "PURCHASE FAILED · NOTHING GRANTED";
                return "ORDER PENDING · NEXT BOOT WILL RECONCILE";
            },
            onClaimSecondWind: async () => {
                const outcome = await claimSecondWind(runRevives, onAdPresentation);
                if (outcome.granted) {
                    runRevives += 1;
                    core.revive();
                    lastPhase = "running";
                    deathHold = 0;
                    scene.setMode("run");
                    audioManager.setMode("run");
                    ui.showRunning();
                    audioManager.play("reward");
                    haptic("success");
                }
                return { granted: outcome.granted, message: outcome.message ?? "" };
            },
            onMonetizationSurfaceViewed: (surfaceId) => {
                analytics.funnelStep("purchase", 1);
                recordAnalytics("store_opened", {
                    surfaceId,
                    placement: `${surfaceId}_screen`,
                    progression: saveSystem.get().records.bestDistance,
                });
            },
            onAdOfferViewed: (status) => {
                recordAnalytics("offer_shown", {
                    placementId: "rewarded_second_wind",
                    adType: "rewarded",
                    rewardId: "second_wind_revive",
                    status,
                });
            },
            onUiSound: (kind) => audioManager.play(kind === "confirm" ? "confirm" : "ui"),
            onLoadLeaderboard: (period) => loadLeaderboard(period),
        },
        {
            wallet: () => saveSystem.get().wallet.cells,
            records: () => saveSystem.get().records,
            upgrades: upgradeRows,
            missions: missionViews,
            unclaimedMissions: unclaimedMissionCount,
            daily: dailyRewardsView,
            secondWind: () => secondWindView(runRevives),
            products: () => [productCommerceView("neon_core"), productCommerceView("cell_cache")],
        },
    );
    scene.app.ticker.add(frame);

    registerLifecycles({
        onPause: pauseRun,
        onResume: resumeRun,
        onSleep: () => {
            // Re-anchor the 24h nudge to now, so it lands a day after the player
            // actually stopped rather than a day after install.
            void returnReminders.refreshPrimary();
            analytics.sessionPause();
            pauseRun();
            audioManager.setPaused(true);
            void saveSystem.flush();
        },
        onAwake: () => {
            // Re-read the capability snapshot: grants/attaches while asleep
            // must not leave the session frozen on its boot snapshot.
            refreshRunCapabilities();
            void refreshServerTime();
            void refreshMonetization();
        },
        onQuit: () => {
            analytics.sessionEnd();
            void returnReminders.refreshPrimary();
            void saveSystem.flush();
        },
        onBackButton: () => {
            const screen = ui.currentScreen();
            if (screen === "hud") pauseRun();
            else if (screen === "pause") backToMenu();
            else if (screen === "menu") void requestHostExit();
            else backToMenu();
        },
    });
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) pauseRun();
    });

    installBrowserQaContract({
        core,
        scene,
        ui,
        performanceHud,
        startRun,
        freezeSimulation: () => {
            qaSimulationFrozen = true;
        },
    });

    recordAnalytics("game_opened", {
        version: __APP_VERSION__,
        saveSource,
        orientation: scene.getViewport().orientation,
    });
    // Boot reached a playable frame; everything after this is the first-run funnel.
    analytics.funnelStep("load", 4);
    analytics.funnelStep("ftue", 1, { save_source: saveSource });
    analytics.sessionStart(saveSystem.get().records.totalRuns === 0);
    // A failed boot could not report itself; the watchdog left the record in
    // localStorage for this session to carry.
    reportBootOutcome();

    updateBoot(100, "SKYLINE READY");
    window.setTimeout(liftBootCover, 140);
}

function preventBrowserChrome(event: Event): void {
    event.preventDefault();
}

document.addEventListener("selectstart", preventBrowserChrome);
document.addEventListener("contextmenu", preventBrowserChrome);
document.addEventListener("dragstart", preventBrowserChrome);

window.addEventListener("unhandledrejection", (event) => {
    console.warn("[runtime] guarded unhandled rejection", event.reason);
    event.preventDefault();
});

void boot().catch((error) => {
    console.error("[boot] fatal startup failure", error);
    updateBoot(100, "BOOT FAILED · RELOAD TO RETRY");
});
