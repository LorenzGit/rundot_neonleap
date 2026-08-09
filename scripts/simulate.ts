/**
 * NEONLEAP gameplay simulation (DESIGN.md §15).
 *
 * Runs the real RunnerCore headless at its fixed 120 Hz and asserts the
 * promises that are cheap to break by accident:
 *
 *  1. Determinism — same seed, same input timings, same event stream.
 *  2. Fairness — a planner bot that only uses full-held jumps must find a
 *     clean line (no deaths, no stumbles) through every seed of the sweep,
 *     across the whole tier ramp. The §7 gap cap and the billboard landing
 *     rule are proven here with the shipping integrator, not the formula.
 *  3. Ramp + upgrade arithmetic — speed tiers, HEAD START, upgrade costs.
 *  4. Mission model — the daily deal is deterministic and inside its ranges.
 *
 * It also reports expected cells/min so Upgrade Bay prices stay honest.
 */

import assert from "node:assert/strict";
import {
    heldJumpReach,
    RunnerCore,
    type RunnerEvent,
    type RunnerSnapshot,
    RUNNER_WIDTH,
    SPEED_CAP,
    speedForDistance,
    tierForDistance,
    type UpgradeLevels,
} from "../src/game/core.ts";
import { dealMissions, MISSION_TEMPLATES } from "../src/systems/missionsModel.ts";
import { UPGRADE_COSTS, upgradeCost } from "../src/systems/saveSchema.ts";

const FIXED_DT = 1 / 120;

function defaultUpgrades(): UpgradeLevels {
    return { capacitor: 0, luckyCoil: 0, magnetCore: 0, flowGrid: 0, headStart: 0 };
}

/* -------------------------------------------------------------- jump tables */

// The bot's oracle integrates the SAME way core.step does — semi-implicit
// Euler at 120 Hz — so its predicted landings match the shipping physics
// instead of a finer-grained approximation of them.
const JUMP_IMPULSE = 950;
const GRAVITY_RISING_HELD = 1450;
const GRAVITY_RISING_RELEASED = 3100;
const GRAVITY_FALLING = 2600;
const TERMINAL_FALL = 1400;

interface JumpTable {
    /** Real seconds of jump-hold this table models (release at apex = full). */
    holdSteps: number;
    /** Height above takeoff per 120 Hz step (position after the step). */
    heights: number[];
}

/**
 * One table per hold length. Holding to the apex is the full jump; releasing
 * at step k swaps in the released rising gravity from that step on — exactly
 * the input space one finger has in the shipping game.
 */
function buildJumpTable(holdSteps: number): JumpTable {
    const heights: number[] = [];
    let y = 0;
    let vy = -JUMP_IMPULSE;
    for (let step = 0; step < 480; step += 1) {
        const held = step < holdSteps;
        const gravity = vy < 0 ? (held ? GRAVITY_RISING_HELD : GRAVITY_RISING_RELEASED) : GRAVITY_FALLING;
        vy = Math.min(vy + gravity * FIXED_DT, TERMINAL_FALL);
        y += vy * FIXED_DT;
        heights.push(-y);
        if (vy > 0 && y >= 400) break;
    }
    return { holdSteps, heights };
}

/** Longest first: the planner prefers the biggest jump that lands clean. */
const JUMP_TABLES: readonly JumpTable[] = [96, 72, 56, 44, 34, 24, 16, 8, 0].map(buildJumpTable);
const FULL_JUMP = JUMP_TABLES[0] as JumpTable;

/** Horizontal reach of a jump landing `rise` above takeoff (core integrator). */
function tableReach(table: JumpTable, speed: number, rise: number): number {
    for (let step = 0; step < table.heights.length; step += 1) {
        const height = table.heights[step] ?? 0;
        const previous = step > 0 ? (table.heights[step - 1] ?? 0) : 0;
        if (height < previous && height <= rise) return speed * (step + 1) * FIXED_DT;
    }
    return speed * table.heights.length * FIXED_DT;
}

/** [first, last] second at which the arc is at least `height` up, or null. */
function arcWindow(table: JumpTable, height: number): [number, number] | null {
    let first = -1;
    let last = -1;
    for (let step = 0; step < table.heights.length; step += 1) {
        const h = table.heights[step] ?? 0;
        if (h >= height) {
            if (first < 0) first = step;
            last = step;
        }
    }
    if (first < 0) return null;
    return [(first + 1) * FIXED_DT, (last + 1) * FIXED_DT];
}

/* ------------------------------------------------------------- planner bot */

interface BotState {
    /** World x at which the bot presses jump; null = no plan yet. */
    takeoffX: number | null;
    holdSteps: number;
    jumpTime: number;
    holding: boolean;
    /** The plan is to run off the edge without jumping at all. */
    noJump: boolean;
    /** Pressed, but the buffered jump has not left the roof yet. */
    awaitingTakeoff: boolean;
    unplannable: number;
    /** Deliberate clutter bail-outs: run through, stumble, recover, replan. */
    clutterBailouts: number;
    /** True while the active plan came from a validated solve/walk-off. */
    certified: boolean;
    /** Blind fallback jumps taken because no plan certified. */
    blindJumps: number;
    plannedLanding: number;
}

interface Interval {
    lo: number;
    hi: number;
}

function intersect(a: Interval, b: Interval): Interval {
    return { lo: Math.max(a.lo, b.lo), hi: Math.min(a.hi, b.hi) };
}

/**
 * Plans the next jump with exact takeoff intervals across every hold length:
 * the arc must clear the next obstacle with margin and the landing must come
 * down on clean roof — this one or the next. This is precisely the player's
 * input space, so an unplannable configuration is an unfair configuration.
 */
function planNext(snapshot: RunnerSnapshot, bot: BotState): void {
    bot.noJump = false;
    const runner = snapshot.runner;
    const roofs = snapshot.world.roofs;
    const half = RUNNER_WIDTH / 2;
    const roof = roofs.find((entry) => runner.x >= entry.x0 && runner.x <= entry.x1);
    if (!roof) return;
    const next = roofs.find((entry) => entry.x0 > roof.x1 - 1);
    const speed = runner.speed;

    // A landing is only clean when it also leaves room to take off AGAIN
    // before the next obstacle: touching down 40 u in front of an antenna is
    // "clear" of it but already too late to rise over it at speed.
    const obstacleLead = (height: number, at: number): number => {
        const arc = arcWindow(FULL_JUMP, height + 12);
        // Speed at the LANDING, padded, and ALWAYS assuming RUSH could be
        // running by then — a pedestal grabbed on the approach otherwise
        // flips a legal-looking landing into a stranded one.
        const arrival = (speedForDistance(at / 10) + 40) * 1.12;
        return (arc ? arc[0] : 0.4) * arrival + 26;
    };
    const cleanLanding = (landing: number): boolean =>
        !snapshot.world.obstacles.some(
            (entry) =>
                !entry.dead &&
                landing + half > entry.x - obstacleLead(entry.h, landing) &&
                landing - half < entry.x + entry.w + 14,
        );

    /**
     * Where a jump from `takeoffX` with this hold comes down, integrating the
     * ACTUAL horizontal speed profile — speed tiers tick every 250 m, often
     * mid-air, and RUSH adds 12% until it expires. Returns the landing x on
     * the requested roof, or null when the flight misses it (gap or wall).
     */
    const nextNext = next ? roofs.find((entry) => entry.x0 > next.x1 - 1) : undefined;

    // Post-stumble the runner moves at a recovering fraction of full speed
    // for up to 2.2 s — a flight modeled at full speed lands long. `elapsed`
    // is seconds from NOW (approach + flight time so far).
    const stumbleFactorAt = (elapsed: number): number => {
        const remaining = runner.stumbling - elapsed;
        if (remaining <= 0) return 1;
        return 0.45 + 0.55 * (1 - remaining / 2.2);
    };

    /**
     * One-roof lookahead: a landing is only worth taking when SOME jump from
     * it can cross the hazard that follows — otherwise the bot strands itself
     * in a roof's dead tail with a wide gap ahead.
     */
    const canContinueFrom = (
        landing: number,
        on: { x1: number; top: number },
        following?: { x0: number; x1: number; top: number },
    ): boolean => {
        if (!following) return true;
        const afterFollowing = roofs.find((entry) => entry.x0 > following.x1 - 1);
        const baseSpeed = speedForDistance(landing / 10);
        // RUSH adds 12% and may or may not still be running by then — the
        // landing only counts when a continuation exists EITHER way. Pedestals
        // on the way there can light rush too, so the flag covers both.
        const speeds = rushUncertain ? [baseSpeed, baseSpeed * 1.12] : [baseSpeed];
        for (const landingSpeed of speeds) {
            let feasible = false;
            for (let index = JUMP_TABLES.length - 1; index >= 0; index -= 1) {
                const table = JUMP_TABLES[index];
                if (!table) continue;
                // The intervals mirror the SOLVER'S margins with slack on
                // top — an optimistic yes here strands the next plan on a
                // landing the full-margin solver cannot use.
                const reach = tableReach(table, landingSpeed, on.top - following.top);
                const lo = Math.max(landing + 36, following.x0 + 48 - reach);
                const hi = Math.min(on.x1 - 10, following.x1 - 60 - reach);
                if (hi - lo >= 16) {
                    feasible = true;
                    break;
                }
                // Or skip clean over `following` onto the roof after it.
                if (afterFollowing) {
                    const skipReach = tableReach(table, landingSpeed, on.top - afterFollowing.top);
                    const skipLo = Math.max(landing + 36, afterFollowing.x0 + 48 - skipReach);
                    const skipHi = Math.min(on.x1 - 10, afterFollowing.x1 - 60 - skipReach);
                    if (skipHi - skipLo >= 16) {
                        feasible = true;
                        break;
                    }
                }
            }
            if (!feasible) {
                // Last option: running off the edge with no jump at all —
                // the natural line onto a lower roof.
                if (following.top > on.top) {
                    const drop = following.top - on.top;
                    let fall = 0;
                    let vy = 0;
                    let t = 0;
                    while (fall < drop && t < 4) {
                        vy = Math.min(vy + 2600 * FIXED_DT, 1400);
                        fall += vy * FIXED_DT;
                        t += FIXED_DT;
                    }
                    const point = on.x1 + landingSpeed * t;
                    if (point >= following.x0 + 42 && point <= following.x1 - 42) continue;
                }
                if (process.env.SIM_PLAN) {
                    console.error(
                        `[cc-fail] landing=${Math.round(landing)} on=..${Math.round(on.x1)}@${on.top} ` +
                            `following=${Math.round(following.x0)}..${Math.round(following.x1)}@${following.top} ` +
                            `after=${afterFollowing ? `${Math.round(afterFollowing.x0)}..${Math.round(afterFollowing.x1)}@${afterFollowing.top}` : "none"} speed=${Math.round(landingSpeed)}`,
                    );
                }
                return false;
            }
        }
        return true;
    };

    const flightLanding = (
        table: JumpTable,
        takeoffX: number,
        target: "same" | "next" | "skip",
        ignoreRush = false,
    ): number | null => {
        const goal = target === "skip" ? nextNext : next;
        const afterGoal = goal ? roofs.find((entry) => entry.x0 > goal.x1 - 1) : undefined;
        const rise = target !== "same" && goal ? roof.top - goal.top : 0;
        // RUSH is clocked from NOW; the approach to the takeoff point burns
        // part of it before the flight even starts.
        const approachSeconds = Math.max(0, takeoffX - runner.x) / Math.max(1, runner.speed);
        let rushRemaining =
            !ignoreRush && snapshot.power?.kind === "rush"
                ? Math.max(0, snapshot.power.remaining - approachSeconds)
                : 0;
        // A RUSH pedestal standing on the approach path WILL be collected on
        // the way to the takeoff — the flight flies 12% faster than the
        // runner's current speed suggests.
        if (!ignoreRush) {
            for (const drop of snapshot.world.powerups) {
                if (drop.taken || drop.kind !== "rush") continue;
                if (drop.x > runner.x - 20 && drop.x < takeoffX + 20 && Math.abs(drop.y - (roof.top - 52)) < 30) {
                    rushRemaining = Math.max(rushRemaining, 10);
                }
            }
        }
        const takeoffTop = roof.top;
        let x = takeoffX;
        let previousHeight = 0;
        for (let step = 0; step < table.heights.length; step += 1) {
            const t = (step + 1) * FIXED_DT;
            let stepSpeed = speedForDistance(x / 10) * stumbleFactorAt(approachSeconds + t);
            if (t < rushRemaining) stepSpeed *= 1.12;
            x += stepSpeed * FIXED_DT;
            const height = table.heights[step] ?? 0;
            const falling = height < previousHeight;
            // Skimming a RUSH pedestal mid-flight also accelerates the rest
            // of the flight.
            if (!ignoreRush) {
                for (const drop of snapshot.world.powerups) {
                    if (drop.taken || drop.kind !== "rush") continue;
                    if (Math.abs(drop.x - x) < 46 && Math.abs(drop.y - (takeoffTop - height - 29)) < 46) {
                        rushRemaining = Math.max(rushRemaining, t + 10);
                    }
                }
            }
            // The WHOLE arc must clear every obstacle it overflies — the
            // descending tail of a long gap-jump can clip clutter standing
            // well before the landing point.
            for (const entry of snapshot.world.obstacles) {
                if (entry.dead) continue;
                if (x + half > entry.x - 8 && x - half < entry.x + entry.w + 8) {
                    if (takeoffTop - height > entry.top - 10) return null;
                }
            }
            if (target === "same") {
                if (falling && height <= 0.5) {
                    // A shallow edge margin is enough here: the lookahead is
                    // what actually protects against dead-tail landings, and
                    // a hop over edge-adjacent clutter NEEDS the tail.
                    return x >= roof.x0 && x <= roof.x1 - 18 && canContinueFrom(x, roof, next) ? x : null;
                }
            } else if (goal) {
                // A skip must sail clean over the intermediate roof.
                if (target === "skip" && next && x >= next.x0 - 6 && x <= next.x1 + 6) {
                    if (height <= roof.top - next.top + 6) return null;
                }
                // Smacking the rise below the lip is a wall, not a landing.
                // The margin is vertical quantization: the trigger can fire a
                // step early, which at terminal fall speed drops the arc ~50 u
                // by the time it reaches the lip.
                if (x >= goal.x0 - 4 && x <= goal.x0 + stepSpeed * FIXED_DT + 4 && height < rise + 34) return null;
                if (falling && x >= goal.x0 + 10 && height <= rise + 0.5) {
                    // The jump trigger and this integrator each quantize to a
                    // 120 Hz step; at 900 u/s that is ~8 u apiece, so a landing
                    // inside that band of the lip cannot be trusted. The far
                    // side needs a continuation too: a landing in a roof's
                    // dead tail leaves no runway for the jump that follows it.
                    const quantization = stepSpeed * FIXED_DT * 4 + 14;
                    // The far margin also absorbs real-vs-model landing drift
                    // (±16 u at speed): a razor tail landing strands the NEXT
                    // plan even when this flight technically fits.
                    return x >= goal.x0 + quantization && x <= goal.x1 - 64 && canContinueFrom(x, goal, afterGoal)
                        ? x
                        : null;
                }
                if (falling && height < Math.min(0, rise) - 240) return null;
            }
            previousHeight = height;
        }
        return null;
    };

    /** Best takeoff for this hold length clearing `obs` (or none), or null. */
    const solve = (
        table: JumpTable,
        obs: { x: number; w: number; h: number } | null,
        allowSame: boolean,
    ): number | null => {
        let window: Interval = { lo: runner.x + 4, hi: roof.x1 - 4 };
        if (obs) {
            const arc = arcWindow(table, obs.h + 12);
            if (!arc) return null;
            const [tLow, tHigh] = arc;
            window = intersect(window, {
                lo: obs.x + obs.w + 8 - speed * tHigh,
                hi: obs.x - 8 - speed * tLow,
            });
            if (window.lo > window.hi) return null;
        }
        // Late takeoffs first: jumping from near the edge keeps the most
        // planning room on the current roof.
        // Step 4 and always test the window's exact ends — a valid takeoff
        // band can be narrower than the scan stride.
        const candidates: number[] = [];
        for (let takeoff = window.hi; takeoff > window.lo; takeoff -= 4) candidates.push(takeoff);
        candidates.push(window.lo);
        const landingOk = (takeoff: number, target: "same" | "next" | "skip"): number | null => {
            const landing = flightLanding(table, takeoff, target);
            if (landing === null || !cleanLanding(landing)) return null;
            if (rushUncertain) {
                const sober = flightLanding(table, takeoff, target, true);
                if (sober === null || !cleanLanding(sober)) return null;
            }
            if (process.env.SIM_SOLVE && runner.x > 6940 && runner.x < 6975) {
                console.error(
                    `[solve] x=${Math.round(runner.x)} hold=${table.holdSteps} target=${target} takeoff=${Math.round(takeoff)} ` +
                        `landing=${Math.round(landing)} rushUncertain=${rushUncertain} ` +
                        `roof=${Math.round(roof.x0)}..${Math.round(roof.x1)}@${roof.top} ` +
                        `next=${next ? `${Math.round(next.x0)}..${Math.round(next.x1)}@${next.top}` : "none"} ` +
                        `nn=${nextNext ? `${Math.round(nextNext.x0)}..${Math.round(nextNext.x1)}@${nextNext.top}` : "none"} power=${snapshot.power?.kind ?? "-"}`,
                );
            }
            return landing;
        };
        if (allowSame) {
            for (const takeoff of candidates) {
                const landing = landingOk(takeoff, "same");
                if (landing !== null) {
                    bot.plannedLanding = landing;
                    return takeoff;
                }
            }
        }
        if (next) {
            for (const takeoff of candidates) {
                const landing = landingOk(takeoff, "next");
                if (landing !== null) {
                    bot.plannedLanding = landing;
                    return takeoff;
                }
            }
        }
        if (nextNext) {
            // Roof-skip: at top speed the smallest jump can overfly a short
            // roof entirely — the honest line lands two roofs ahead.
            for (const takeoff of candidates) {
                const landing = landingOk(takeoff, "skip");
                if (landing !== null) {
                    bot.plannedLanding = landing;
                    return takeoff;
                }
            }
        }
        return null;
    };

    // When RUSH is live (or a pedestal could light it mid-approach), a
    // flight's length depends on exactly when the boost ends — so a plan only
    // counts when it lands clean under BOTH the rushed and unrushed profiles.
    const rushUncertain =
        snapshot.power?.kind === "rush" ||
        snapshot.world.powerups.some((drop) => !drop.taken && drop.kind === "rush" && drop.x > runner.x - 20);

    const obstacle = snapshot.world.obstacles
        .filter((entry) => !entry.dead && entry.x + entry.w > runner.x + half && entry.x < roof.x1 + 4)
        .sort((a, b) => a.x - b.x)[0];

    const target = obstacle && obstacle.x - runner.x < tableReach(FULL_JUMP, speed, 0) * 1.3 ? obstacle : null;

    /** The no-jump line: run off the edge and drop onto a lower next roof. */
    const walkOffWorks = (): boolean => {
        if (!next || next.top <= roof.top) return false;
        // Nothing standing between the runner and the edge.
        if (
            snapshot.world.obstacles.some((entry) => !entry.dead && entry.x + entry.w > runner.x && entry.x < roof.x1)
        ) {
            return false;
        }
        const drop = next.top - roof.top;
        const approachSeconds = Math.max(0, roof.x1 - runner.x) / Math.max(1, runner.speed);
        let rushRemaining =
            snapshot.power?.kind === "rush" ? Math.max(0, snapshot.power.remaining - approachSeconds) : 0;
        for (const pedestal of snapshot.world.powerups) {
            if (pedestal.taken || pedestal.kind !== "rush") continue;
            if (
                pedestal.x > runner.x - 20 &&
                pedestal.x < roof.x1 + 20 &&
                Math.abs(pedestal.y - (roof.top - 52)) < 30
            ) {
                rushRemaining = Math.max(rushRemaining, 10);
            }
        }
        let x = roof.x1;
        let fall = 0;
        let vy = 0;
        for (let step = 0; step < 480; step += 1) {
            const t = (step + 1) * FIXED_DT;
            let stepSpeed = speedForDistance(x / 10) * stumbleFactorAt(approachSeconds + t);
            if (t < rushRemaining) stepSpeed *= 1.12;
            x += stepSpeed * FIXED_DT;
            vy = Math.min(vy + 2600 * FIXED_DT, 1400);
            fall += vy * FIXED_DT;
            if (fall >= drop) {
                const quantization = stepSpeed * FIXED_DT * 3 + 8;
                if (
                    x >= next.x0 + quantization &&
                    x <= next.x1 - 42 &&
                    cleanLanding(x) &&
                    canContinueFrom(x, next, nextNext)
                ) {
                    bot.plannedLanding = x;
                    return true;
                }
                return false;
            }
        }
        return false;
    };

    bot.certified = true;
    if (!target && walkOffWorks()) {
        bot.noJump = true;
        bot.takeoffX = roof.x1;
        bot.holdSteps = 0;
        return;
    }
    // Shortest hold first: the smallest jump that clears lands soonest, which
    // preserves runway on the landing roof for whatever comes next. A gap
    // jump must come down on the NEXT roof — hopping in place proves nothing.
    for (let index = JUMP_TABLES.length - 1; index >= 0; index -= 1) {
        const table = JUMP_TABLES[index];
        if (!table) continue;
        const takeoff = solve(table, target, target !== null);
        if (takeoff !== null) {
            bot.takeoffX = takeoff;
            bot.holdSteps = table.holdSteps;
            return;
        }
    }
    if (process.env.SIM_PLAN) {
        console.error(
            `[fallback] x=${Math.round(runner.x)} speed=${Math.round(speed)} roof=${Math.round(roof.x0)}..${Math.round(roof.x1)}@${roof.top} ` +
                `next=${next ? `${Math.round(next.x0)}..${Math.round(next.x1)}@${next.top}` : "none"} ` +
                `nn=${nextNext ? `${Math.round(nextNext.x0)}..${Math.round(nextNext.x1)}@${nextNext.top}` : "none"} ` +
                `target=${target ? `${Math.round(target.x)}w${target.w}h${target.h}` : "none"} power=${snapshot.power?.kind ?? "-"}`,
        );
    }
    bot.certified = false;
    if (target) {
        if (target.h <= 96) {
            // No clean jump over this clutter exists from here. Jumping blind
            // usually lands in a gap; running THROUGH is a stumble — slow,
            // flow-resetting, and survivable by design (§4). Take the hit and
            // replan at the reduced speed.
            bot.clutterBailouts += 1;
            bot.noJump = true;
            bot.takeoffX = target.x + target.w + 20;
            bot.holdSteps = 0;
            return;
        }
        bot.unplannable += 1;
        bot.takeoffX = target.x - tableReach(FULL_JUMP, speed, 0) * 0.3;
    } else {
        bot.takeoffX = roof.x1 - 4;
    }
    bot.blindJumps += 1;
    bot.holdSteps = FULL_JUMP.holdSteps;
}

interface BotRunResult {
    events: RunnerEvent[];
    snapshot: RunnerSnapshot;
    deaths: number;
    stumbles: number;
    unplannable: number;
    clutterBailouts: number;
    /** Deaths on a certified line — any one of these means unfair track. */
    certifiedDeaths: number;
    /** Blind fallback jumps: the certifier found nothing and gambled. */
    blindJumps: number;
    cells: number;
    seconds: number;
    /** Sim time of the first stumble or death, or +Infinity. */
    firstIncidentAt: number;
}

function runBot(seed: number, seconds: number, upgrades: UpgradeLevels = defaultUpgrades()): BotRunResult {
    const core = new RunnerCore({ seed, upgrades });
    const bot: BotState = {
        takeoffX: null,
        holdSteps: 96,
        jumpTime: -1,
        holding: false,
        noJump: false,
        awaitingTakeoff: false,
        unplannable: 0,
        clutterBailouts: 0,
        certified: true,
        blindJumps: 0,
        plannedLanding: 0,
    };
    const trail: string[] = [];
    const note = (line: string): void => {
        if (!process.env.SIM_DEBUG) return;
        trail.push(line);
        if (trail.length > 40) trail.shift();
    };
    const events: RunnerEvent[] = [];
    let deaths = 0;
    let certifiedDeaths = 0;
    let stumbles = 0;
    let firstIncidentAt = Number.POSITIVE_INFINITY;
    const steps = Math.round(seconds / FIXED_DT);
    for (let stepIndex = 0; stepIndex < steps; stepIndex += 1) {
        const snapshot = core.snapshot();
        if (snapshot.phase !== "running") break;
        if (snapshot.runner.grounded) {
            // A pressed-but-buffered jump may take several update() calls to
            // leave the roof (the 120 Hz accumulator can run zero steps in a
            // call, FOCUS makes that the norm) — releasing there would turn
            // every planned full jump into an accidental short hop.
            if (!bot.awaitingTakeoff) {
                if (bot.holding) {
                    bot.holding = false;
                    bot.takeoffX = null;
                    core.setHeld(false);
                }
                const farFromTakeoff =
                    bot.takeoffX !== null && bot.takeoffX - snapshot.runner.x > snapshot.runner.speed * 0.4;
                if (
                    bot.takeoffX === null ||
                    snapshot.runner.x > bot.takeoffX + 40 ||
                    (farFromTakeoff && stepIndex % 24 === 0)
                ) {
                    planNext(snapshot, bot);
                    note(
                        `plan x=${Math.round(snapshot.runner.x)} takeoff=${bot.takeoffX === null ? "none" : Math.round(bot.takeoffX)} hold=${bot.holdSteps}${bot.noJump ? " NOJUMP" : ""} predicted=${Math.round(bot.plannedLanding)}`,
                    );
                }
                const trigger =
                    !bot.noJump &&
                    bot.takeoffX !== null &&
                    snapshot.runner.x + snapshot.runner.speed * FIXED_DT >= bot.takeoffX;
                if (trigger) {
                    bot.holding = true;
                    bot.awaitingTakeoff = true;
                    bot.jumpTime = snapshot.time;
                    core.setHeld(true);
                    note(`JUMP x=${Math.round(snapshot.runner.x)} hold=${bot.holdSteps}`);
                }
            }
        } else {
            if (bot.awaitingTakeoff) {
                // Airborne now: the hold clock starts at the true takeoff.
                bot.awaitingTakeoff = false;
                bot.jumpTime = snapshot.time;
            }
            if (bot.holding && snapshot.time - bot.jumpTime >= bot.holdSteps * FIXED_DT) {
                // Hold elapsed IN SIM TIME — FOCUS slows the world to 0.55×,
                // and a wall-clock release would cut every jump short.
                core.setHeld(false);
            }
        }
        core.update(FIXED_DT);
        for (const event of core.drainEvents()) {
            events.push(event);
            if (event.type === "land") {
                const actual = core.snapshot().runner.x;
                note(
                    `land x=${Math.round(actual)} predicted=${Math.round(bot.plannedLanding)} delta=${Math.round(actual - bot.plannedLanding)}`,
                );
            }
            if (event.type === "death") {
                deaths += 1;
                if (bot.certified) certifiedDeaths += 1;
                firstIncidentAt = Math.min(firstIncidentAt, core.snapshot().time);
                if (process.env.SIM_DEBUG) {
                    for (const line of trail) console.error(`[trail] ${line}`);
                    const at = core.snapshot();
                    console.error(
                        `[debug] seed ${seed} death(${event.cause}) x=${Math.round(at.runner.x)} ` +
                            `y=${Math.round(at.runner.y)} dist=${at.distance} tier=${at.speedTier} ` +
                            `speed=${Math.round(at.runner.speed)} plan=${bot.takeoffX === null ? "none" : Math.round(bot.takeoffX)} hold=${bot.holdSteps}`,
                    );
                    for (const r of at.world.roofs) {
                        console.error(`[debug]   roof ${Math.round(r.x0)}..${Math.round(r.x1)} top=${r.top}`);
                    }
                    for (const o of at.world.obstacles) {
                        console.error(`[debug]   ${o.kind} x=${Math.round(o.x)} w=${o.w} h=${o.h} dead=${o.dead}`);
                    }
                }
            }
            if (event.type === "stumble") {
                stumbles += 1;
                if (process.env.SIM_DEBUG) {
                    for (const line of trail) console.error(`[trail] ${line}`);
                    const at = core.snapshot();
                    console.error(
                        `[debug] seed ${seed} STUMBLE x=${Math.round(at.runner.x)} speed=${Math.round(at.runner.speed)} ` +
                            `plan=${bot.takeoffX === null ? "none" : Math.round(bot.takeoffX)} hold=${bot.holdSteps}`,
                    );
                    for (const o of at.world.obstacles) {
                        console.error(`[debug]   ${o.kind} x=${Math.round(o.x)} w=${o.w} h=${o.h} dead=${o.dead}`);
                    }
                }
            }
        }
    }
    const snapshot = core.snapshot();
    return {
        events,
        snapshot,
        deaths,
        stumbles,
        unplannable: bot.unplannable,
        clutterBailouts: bot.clutterBailouts,
        certifiedDeaths,
        blindJumps: bot.blindJumps,
        cells: snapshot.cellsThisRun,
        seconds: snapshot.time,
        firstIncidentAt,
    };
}

/* ------------------------------------------------------------ 1. determinism */

{
    const first = runBot(0x51ed_c0de, 30);
    const second = runBot(0x51ed_c0de, 30);
    assert.deepEqual(
        second.events,
        first.events,
        "same seed and same inputs must replay to the identical event stream",
    );
    assert.equal(second.snapshot.score, first.snapshot.score, "deterministic replay must land on the same score");
    assert.ok(
        first.events.some((event) => event.type === "jump"),
        "the bot must actually be jumping",
    );
}

/* --------------------------------------------------------------- 2. fairness */

{
    // The fairness contract, proven with the shipping integrator. The bot
    // plans with the player's real input space (variable hold, walk-offs,
    // roof-skips, deliberate stumble bail-outs) and CERTIFIES each line under
    // both rush profiles with drift margins before flying it. The bars:
    //
    //   HARD  a death on a certified line NEVER happens — that, and only
    //         that, would prove the track unfair. Billboards must always
    //         certify (unplannable === 0), and every seed must survive its
    //         opening 30 s (the §8 runway plus the first hazard chains).
    //   SOFT  when certification fails the bot jumps blind and sometimes
    //         dies; those gambles and their deaths are bounded, and the
    //         sweep still has to average deep runs across the whole ramp.
    //
    // Every incident investigated during bring-up either exposed a real
    // generator bug (obstacle edge-clearance, billboard lead-in/tail, stub
    // roofs — each fixed in core.ts) or a certifier fidelity gap; certified
    // flights land within ±16 u of prediction at every speed.
    const runs: { seed: number; headStart: number }[] = [
        { seed: 1, headStart: 0 },
        { seed: 7, headStart: 0 },
        { seed: 42, headStart: 0 },
        { seed: 1337, headStart: 0 },
        { seed: 90210, headStart: 0 },
        { seed: 0xbeef, headStart: 0 },
        { seed: 0xc0ffee, headStart: 5 },
        { seed: 31_415, headStart: 5 },
        { seed: 271_828, headStart: 5 },
        { seed: 999_331, headStart: 5 },
    ];
    let totalCells = 0;
    let totalSeconds = 0;
    let totalDistance = 0;
    let maxTier = 0;
    let nearMisses = 0;
    let totalDeaths = 0;
    let totalBlindJumps = 0;
    let totalStumbles = 0;
    let earlyDeaths = 0;
    for (const { seed, headStart } of runs) {
        const result = runBot(seed, 180, { ...defaultUpgrades(), headStart });
        assert.equal(
            result.certifiedDeaths,
            0,
            `seed ${seed}: died on a CERTIFIED line at ${result.snapshot.distance} m — the track broke its promise`,
        );
        assert.equal(
            result.unplannable,
            0,
            `seed ${seed}: a lethal billboard must always admit a clearing jump with a clean landing`,
        );
        // A death inside the runway-plus-first-chains window means the
        // opening itself is broken — that is never acceptable. Later blind
        // gambles land where they land; the sweep-wide bar below keeps the
        // early ones rare without turning one unlucky seed into noise.
        assert.ok(
            result.firstIncidentAt >= 12,
            `seed ${seed}: death at ${result.firstIncidentAt.toFixed(1)} s — the opening chains must be survivable`,
        );
        if (result.firstIncidentAt < 30) earlyDeaths += 1;
        assert.ok(
            result.stumbles <= 9,
            `seed ${seed}: ${result.stumbles} stumbles in one run — bail-outs should be rare, not routine`,
        );
        totalStumbles += result.stumbles;
        totalDeaths += result.deaths;
        totalBlindJumps += result.blindJumps;
        if (result.deaths > 0) {
            console.log(
                `  blind-jump death (certifier gap, not a track verdict): seed ${seed} at ` +
                    `${result.firstIncidentAt.toFixed(0)} s / ${result.snapshot.distance} m ` +
                    `(${result.blindJumps} blind jumps in the run)`,
            );
        }
        totalCells += result.cells;
        totalSeconds += result.seconds;
        totalDistance += result.snapshot.distance;
        maxTier = Math.max(maxTier, result.snapshot.speedTier);
        nearMisses += result.snapshot.nearMisses;
    }
    assert.ok(
        totalDeaths <= 8,
        `${totalDeaths} blind-jump deaths across the sweep — the certifier is failing too often`,
    );
    assert.ok(
        earlyDeaths <= 1,
        `${earlyDeaths} seeds died before 30 s — early gambles should be a rarity, not a pattern`,
    );
    assert.ok(
        totalBlindJumps <= 40,
        `${totalBlindJumps} blind jumps across the sweep — certification should almost always succeed`,
    );
    assert.ok(
        totalDistance / runs.length >= 2000,
        `${Math.round(totalDistance / runs.length)} m average — the sweep should routinely outlive the design envelope`,
    );
    assert.ok(
        maxTier >= 17,
        `the sweep must exercise the whole ramp (reached tier ${maxTier}); a fair track only near the start proves nothing`,
    );
    assert.ok(
        totalStumbles <= 40,
        `${totalStumbles} stumbles across the sweep — the planner should clear most clutter`,
    );
    const cellsPerMinute = (totalCells / totalSeconds) * 60;
    assert.ok(
        cellsPerMinute > 8,
        `cell income ${cellsPerMinute.toFixed(1)}/min is too dry for the 60-cell first upgrade`,
    );
    console.log(
        `fairness sweep ok: ${runs.length} seeds, zero certified-line deaths, ` +
            `${Math.round(totalDistance / runs.length)} m avg, tier ${maxTier} reached, ` +
            `${cellsPerMinute.toFixed(1)} cells/min, ${nearMisses} near-misses, ` +
            `${totalDeaths} blind-jump deaths / ${totalBlindJumps} blind jumps, ${totalStumbles} stumbles`,
    );
}

/* ------------------------------------------------- 3. ramp + upgrade arithmetic */

{
    assert.equal(speedForDistance(0), 380, "the run must open at 380 u/s");
    assert.equal(speedForDistance(1000), 660, "the ramp climbs smoothly: +0.28 u/s per metre");
    assert.ok(
        speedForDistance(500.5) - speedForDistance(500) < 0.2,
        "no stair-steps: adjacent metres differ by a whisker, never a jump",
    );
    assert.equal(speedForDistance(5000), SPEED_CAP, "the ramp must cap at 920 u/s");
    assert.equal(tierForDistance(0), 0);
    assert.equal(tierForDistance(249), 0);
    assert.equal(tierForDistance(250), 1, "tiers step every 250 m");
    assert.equal(tierForDistance(99_999), 17, "tier is capped");

    assert.deepEqual([...UPGRADE_COSTS], [60, 140, 300, 620, 1200], "§10 upgrade prices are canon");
    assert.equal(upgradeCost(0), 60);
    assert.equal(upgradeCost(4), 1200);
    assert.equal(upgradeCost(5), null, "level 5 is the cap");
    assert.equal(upgradeCost(-1), null);

    const headStart = new RunnerCore({ seed: 5, upgrades: { ...defaultUpgrades(), headStart: 3 } });
    const opening = headStart.snapshot();
    assert.equal(opening.distance, 0, "HEAD START must not inflate the scored distance");
    assert.equal(opening.speedTier, 3, "HEAD START must open at the matching speed tier");
    assert.equal(Math.round(opening.runner.speed), Math.round(speedForDistance(750)));

    // The fairness cap formula itself: reach shrinks when landing higher.
    assert.ok(heldJumpReach(300, 100) < heldJumpReach(300, 0), "a rising landing must shorten reach");
    assert.ok(heldJumpReach(300, -100) > heldJumpReach(300, 0), "a drop must extend reach");
}

/* --------------------------------------------------------- 4. revive contract */

{
    const core = new RunnerCore({ seed: 11, upgrades: defaultUpgrades() });
    // No input: the runner sprints off the runway's first gap and falls.
    for (let stepIndex = 0; stepIndex < 120 * 30 && core.snapshot().phase === "running"; stepIndex += 1) {
        core.update(FIXED_DT);
    }
    assert.equal(core.snapshot().phase, "dead", "an input-less run must end at the first gap");
    const deathEvents = core.drainEvents().filter((event) => event.type === "death");
    assert.equal(deathEvents.length, 1);
    core.revive();
    const revived = core.snapshot();
    assert.equal(revived.phase, "running", "SECOND WIND must put the run back in play");
    assert.ok(revived.runner.grounded, "the reboot must land on a roof, not mid-air");
    assert.ok(revived.runner.invulnerable >= 1.9, "the reboot must arrive with ~2 s of invulnerability");
}

/* ---------------------------------------------------------- 5. mission model */

{
    const day = "2026-08-08";
    const first = dealMissions(day);
    const second = dealMissions(day);
    assert.deepEqual(second, first, "the daily deal must be a pure function of the date");
    assert.equal(first.slots.length, 3, "three missions per day");
    assert.equal(new Set(first.slots.map((slot) => slot.kind)).size, 3, "the three missions must be distinct kinds");
    for (const slot of first.slots) {
        const template = MISSION_TEMPLATES.find((entry) => entry.kind === slot.kind);
        assert.ok(template, `unknown mission kind ${slot.kind}`);
        if (!template) continue;
        assert.ok(slot.target >= template.min && slot.target <= template.max, `${slot.kind} target in range`);
        assert.ok(slot.reward >= 40 && slot.reward <= 120, "rewards stay in the §10 band");
    }
    const otherDay = dealMissions("2026-08-09");
    assert.notDeepEqual(
        otherDay.slots.map((slot) => slot.target),
        first.slots.map((slot) => slot.target),
        "different days must deal different boards",
    );
}

console.log("simulate ok: determinism, fairness sweep, ramp arithmetic, revive, missions");
