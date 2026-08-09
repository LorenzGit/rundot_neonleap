/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface Window {
    __neonleapQa?: {
        snapshot(): Record<string, unknown>;
        startRun(): void;
        endRun(): void;
        setHeld(held: boolean): void;
        /** Steps the frozen sim directly — call freezeSimulation() first. */
        step(seconds: number, steps?: number): void;
        pause(): void;
        resume(): void;
        freezeSimulation(): void;
        /** Mean ms per render phase since the last call (development only). */
        phaseTimings(): Record<string, number>;
        previewLeaderboard(rows: { rank: number; name: string; distance: number }[], myRank: number): void;
        setReducedMotion(enabled: boolean): void;
        showMilestone(kicker: string, title: string): void;
    };
}
