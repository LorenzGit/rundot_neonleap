import { audioManager } from "../audio/audioManager.ts";
import type { RunnerCore } from "../game/core.ts";
import type { GameScene } from "../game/scene.ts";
import type { UiController } from "../ui/controller.ts";
import type { PerformanceHud } from "../ui/performanceHud.ts";

/**
 * Development-only semantic contract for headless QA. It may set up local test
 * state but never fabricates a RUN ad, purchase, entitlement, or reward.
 */
export function installBrowserQaContract(deps: {
    core: RunnerCore;
    scene: GameScene;
    ui: UiController;
    performanceHud: PerformanceHud;
    startRun: () => void;
    freezeSimulation: () => void;
}): void {
    if (!import.meta.env.DEV || new URLSearchParams(window.location.search).get("qa") !== "1") return;
    const { core, scene, ui, performanceHud, startRun, freezeSimulation } = deps;
    window.__neonleapQa = {
        snapshot: () => {
            const snapshot = core.snapshot();
            const viewport = scene.getViewport();
            const diagnostics = scene.getPerformanceDiagnostics();
            return {
                phase: snapshot.phase,
                screen: ui.currentScreen(),
                orientation: viewport.orientation,
                viewport: `${viewport.width}x${viewport.height}`,
                designWidth: Math.round(viewport.designWidth),
                distance: snapshot.distance,
                score: snapshot.score,
                speedTier: snapshot.speedTier,
                speed: Math.round(snapshot.runner.speed),
                flowTier: snapshot.flow.tier,
                flowPoints: snapshot.flow.points,
                cells: snapshot.cellsThisRun,
                chain: snapshot.pickupChain,
                stumbles: snapshot.stumbles,
                nearMisses: snapshot.nearMisses,
                smashes: snapshot.smashes,
                power: snapshot.power?.kind ?? null,
                mobility: snapshot.mobility?.kind ?? null,
                timeScale: snapshot.timeScale,
                runnerX: Math.round(snapshot.runner.x),
                runnerY: Math.round(snapshot.runner.y),
                grounded: snapshot.runner.grounded,
                holdingJump: snapshot.runner.holdingJump,
                invulnerable: snapshot.runner.invulnerable,
                roofs: snapshot.world.roofs.length,
                // Driving aids for headless QA: how far to the current roof's
                // edge and to the next live obstacle ahead.
                nextGapIn: (() => {
                    const roof = snapshot.world.roofs.find(
                        (entry) => snapshot.runner.x >= entry.x0 && snapshot.runner.x <= entry.x1,
                    );
                    return roof ? Math.round(roof.x1 - snapshot.runner.x) : -1;
                })(),
                nextObstacleIn: (() => {
                    const ahead = snapshot.world.obstacles
                        .filter((entry) => !entry.dead && entry.x > snapshot.runner.x)
                        .sort((a, b) => a.x - b.x)[0];
                    return ahead ? Math.round(ahead.x - snapshot.runner.x) : -1;
                })(),
                obstacles: snapshot.world.obstacles.length,
                worldCells: snapshot.world.cells.length,
                powerups: snapshot.world.powerups.length,
                particles: diagnostics.particles,
                rainDrops: diagnostics.rainDrops,
                popups: diagnostics.popups,
                cameraShake: diagnostics.cameraShake,
                scale: diagnostics.scale,
                audio: audioManager.debugState(),
                performance: performanceHud.snapshot(),
            };
        },
        startRun,
        endRun: () => {
            core.pause();
        },
        setHeld: (held) => core.setHeld(held),
        step: (seconds, steps = 1) => {
            for (let index = 0; index < Math.max(1, Math.floor(steps)); index += 1) {
                core.update(seconds);
            }
        },
        pause: () => {
            core.pause();
            ui.showPause();
        },
        resume: () => {
            core.resume();
            ui.showRunning();
        },
        freezeSimulation,
        phaseTimings: () => scene.drainPhaseTimings(),
        /** Paints a synthetic board so the populated layout can be reviewed. */
        previewLeaderboard: (rows, myRank) => {
            ui.showLeaderboardScreen();
            ui.renderLeaderboard({
                available: true,
                loading: false,
                period: "alltime",
                rows: rows.map((row) => ({ ...row, isYou: row.rank === myRank })),
                myRank,
                totalPlayers: 1240,
                message: "",
            });
        },
        setReducedMotion: (enabled) => scene.setReducedMotion(enabled),
        showMilestone: (kicker, title) => ui.milestone(kicker, title),
    };
}
