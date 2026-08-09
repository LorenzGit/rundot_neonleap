import type { RunnerEvent, RunnerSnapshot } from "../game/core.ts";

/**
 * Onboarding (DESIGN.md §14): two floating hints, no modals. "TAP TO JUMP"
 * opens the first run and dissolves on the first jump; "HOLD FOR HIGHER" arms
 * at the first wide gap and dissolves once a held jump clears one. A player
 * who has already been coached never sees either again.
 */
export type FtueHint = "tap" | "hold" | null;

const WIDE_GAP = 170;
const LOOKAHEAD = 460;

export class Ftue {
    private done: boolean;
    private jumped = false;
    private heldCleared = false;
    private holdArmed = false;
    private airborneHeldFor = 0;

    constructor(controlsSeen: boolean) {
        this.done = controlsSeen;
    }

    isComplete(): boolean {
        return this.done;
    }

    finish(): void {
        this.done = true;
    }

    /** Feed one frame; returns the hint that should be on screen right now. */
    observe(snapshot: RunnerSnapshot, events: readonly RunnerEvent[], delta: number): FtueHint {
        if (this.done) return null;
        for (const event of events) {
            if (event.type === "jump") this.jumped = true;
        }

        if (!this.jumped) return "tap";

        // Arm the hold lesson when a wide gap is inside the lookahead window.
        if (!this.holdArmed) {
            const roofs = snapshot.world.roofs;
            for (let index = 0; index + 1 < roofs.length; index += 1) {
                const current = roofs[index];
                const next = roofs[index + 1];
                if (!current || !next) continue;
                const gap = next.x0 - current.x1;
                const distanceToGap = current.x1 - snapshot.runner.x;
                if (gap >= WIDE_GAP && distanceToGap > 0 && distanceToGap < LOOKAHEAD) {
                    this.holdArmed = true;
                    break;
                }
            }
        }

        // A held jump that stays held mid-air is the demonstration.
        if (!snapshot.runner.grounded && snapshot.runner.holdingJump) {
            this.airborneHeldFor += delta;
            if (this.airborneHeldFor > 0.3) this.heldCleared = true;
        } else if (snapshot.runner.grounded) {
            this.airborneHeldFor = 0;
        }

        if (this.holdArmed && !this.heldCleared) return "hold";
        if (this.heldCleared) this.done = true;
        return null;
    }
}
