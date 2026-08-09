// NEONLEAP deterministic core (DESIGN.md §2–§9). Headless: no DOM, no wall
// clock, no Math.random — every roll comes from the seeded NoiseRandom. The
// sim steps at a fixed 120 Hz inside update(), so the same seed and the same
// input timings replay to the same run on every device (`npm run simulate`
// holds that as a contract).

import { NoiseRandom } from "./noiseRandom.ts";

export type PowerupKind = "overdrive" | "magnet" | "focus" | "rush" | "jets";
export type UpgradeId = "capacitor" | "luckyCoil" | "magnetCore" | "flowGrid" | "headStart";
export type UpgradeLevels = Record<UpgradeId, number>;
export type RunnerPhase = "ready" | "running" | "paused" | "dead";

export type RunnerEvent =
    | { type: "jump" }
    | { type: "doubleJump" }
    | { type: "land"; impact: number }
    | { type: "edgeSave" }
    | { type: "pickup"; chain: number }
    | { type: "nearMiss" }
    | { type: "stumble" }
    | { type: "smash"; billboard: boolean }
    | { type: "powerupStart"; kind: PowerupKind }
    | { type: "powerupSwap"; from: PowerupKind; to: PowerupKind }
    | { type: "powerupEnd"; kind: PowerupKind }
    | { type: "flowTier"; tier: number }
    | { type: "speedTier"; tier: number }
    | { type: "death"; cause: "fall" | "billboard" }
    | { type: "revive" };

export interface RoofSpan {
    x0: number;
    x1: number;
    top: number;
}

export interface ObstacleView {
    id: number;
    x: number;
    top: number;
    w: number;
    h: number;
    kind: "vent" | "ac" | "antenna" | "billboard";
    dead: boolean;
}

export interface CellView {
    id: number;
    x: number;
    y: number;
    taken: boolean;
}

export interface PowerupView {
    id: number;
    x: number;
    y: number;
    kind: PowerupKind;
    taken: boolean;
}

export interface ActivePowerup {
    kind: PowerupKind;
    remaining: number;
    total: number;
}

export interface RunnerSnapshot {
    phase: RunnerPhase;
    time: number;
    runner: {
        x: number;
        y: number;
        vy: number;
        grounded: boolean;
        holdingJump: boolean;
        speed: number;
        invulnerable: number;
        stumbling: number;
        /** Pressed against a rise, sliding down toward the gap below. */
        wallSliding: boolean;
    };
    camera: { x: number };
    distance: number;
    speedTier: number;
    score: number;
    flow: { tier: number; points: number; nextAt: number };
    cellsThisRun: number;
    pickupChain: number;
    stumbles: number;
    nearMisses: number;
    smashes: number;
    power: ActivePowerup | null;
    mobility: ActivePowerup | null;
    timeScale: number;
    world: { roofs: RoofSpan[]; obstacles: ObstacleView[]; cells: CellView[]; powerups: PowerupView[] };
}

/* ------------------------------------------------------- tuning (canon §2–3) */

export const STAGE_WIDTH = 1280;
export const STAGE_HEIGHT = 720;
export const ROOF_TOP_MIN = 260;
export const ROOF_TOP_MAX = 560;
export const KILL_PLANE = 760;
export const RUNNER_WIDTH = 26;
export const RUNNER_HEIGHT = 58;

const JUMP_IMPULSE = 950;
const GRAVITY_RISING_HELD = 1450;
const GRAVITY_RISING_RELEASED = 3100;
const GRAVITY_FALLING = 2600;
const TERMINAL_FALL = 1400;
const COYOTE_SECONDS = 0.09;
const JUMP_BUFFER_SECONDS = 0.12;
/** The camera holds the runner at 26% of the 1280-wide stage (§2). */
const CAMERA_ANCHOR_X = STAGE_WIDTH * 0.26;
/** Ten world units to a metre; score ticks one point per metre (§6). */
export const UNITS_PER_METRE = 10;

/** Deterministic physics: dt accumulates and the sim always steps this. */
const FIXED_DT = 1 / 120;

/* ------------------------------------------------------------ ramp (canon §7) */

export const SPEED_BASE = 380;
/** The ramp is CONTINUOUS: +0.28 u/s per metre, not a stair-step per tier. */
export const SPEED_PER_METRE = 0.28;
export const SPEED_CAP = 920;
export const TIER_METRES = 250;
export const MAX_TIER = 17;

/**
 * Run speed as a smooth function of distance. Tiers remain the 250 m content
 * milestones (generator knobs, music layers, missions) but the speed itself
 * climbs every metre — the acceleration is felt, never a sudden step.
 */
export function speedForDistance(metres: number): number {
    return Math.min(SPEED_CAP, SPEED_BASE + SPEED_PER_METRE * Math.max(0, metres));
}

export function tierForDistance(metres: number): number {
    return Math.min(MAX_TIER, Math.max(0, Math.floor(metres / TIER_METRES)));
}

/**
 * The generator's difficulty axis: current speed mapped onto the 0–16 knob
 * scale. Content is keyed to how fast the city is actually moving — change
 * the ramp's slope and every gap, obstacle and billboard still arrives at
 * the speed it was tuned for.
 */
export function paceForSpeed(speed: number): number {
    return Math.min(16, Math.max(0, (16 * (speed - SPEED_BASE)) / (SPEED_CAP - SPEED_BASE)));
}

/** Linear interpolation over the §7 knob table (pace 0 / 8 / 16 anchors). */
function knob(pace: number, at0: number, at8: number, at16: number): number {
    const t = Math.min(16, Math.max(0, pace));
    if (t <= 8) return at0 + ((at8 - at0) * t) / 8;
    return at8 + ((at16 - at8) * (t - 8)) / 8;
}

/**
 * Horizontal reach of a full-held jump at `speed`, landing `rise` units ABOVE
 * the takeoff roof (negative rise = landing lower, which extends the arc).
 * Integrated numerically with the exact gameplay constants — this one function
 * is both the generator's fairness cap and the balance bot's oracle.
 */
export function heldJumpReach(speed: number, rise: number): number {
    let y = 0;
    let vy = -JUMP_IMPULSE;
    let elapsed = 0;
    const step = 1 / 240;
    // Rising with the held gravity, then falling until we are `rise` above
    // the takeoff height (y is down-positive, so "above by rise" is y = -rise).
    for (let guard = 0; guard < 2400; guard += 1) {
        const gravity = vy < 0 ? GRAVITY_RISING_HELD : GRAVITY_FALLING;
        vy = Math.min(vy + gravity * step, TERMINAL_FALL);
        y += vy * step;
        elapsed += step;
        if (vy > 0 && y >= -rise) break;
    }
    return speed * elapsed;
}

/* -------------------------------------------------------- powerups (canon §9) */

export const POWERUP_KINDS: readonly PowerupKind[] = ["overdrive", "magnet", "focus", "rush", "jets"];

export const POWERUP_BASE_SECONDS: Readonly<Record<PowerupKind, number>> = {
    overdrive: 8,
    magnet: 10,
    focus: 6,
    rush: 10,
    jets: 12,
};

const MAGNET_BASE_RADIUS = 190;
const FOCUS_TIME_SCALE = 0.55;
const RUSH_SPEED_BONUS = 1.12;
const RUSH_SCORE_MULT = 2;

/* ------------------------------------------------------------- flow (canon §5) */

const FLOW_TIER_THRESHOLDS = [6, 14, 26] as const;
const FLOW_MAX_TIER = 4;

/* ----------------------------------------------------------- score (canon §6) */

const SCORE_CELL = 10;
const SCORE_NEAR_MISS = 25;
const SCORE_SMASH = 15;
const SCORE_SMASH_BILLBOARD = 40;

/* ------------------------------------------------------------------ stumble */

const STUMBLE_SPEED_FACTOR = 0.45;
/** Seconds of post-stumble invulnerability (§4). */
const STUMBLE_INVULN_SECONDS = 1.2;
/** Seconds a stumble takes to ramp back to full speed. */
const STUMBLE_RECOVERY_SECONDS = 2.2;
const NEAR_MISS_CLEARANCE = 24;
const EDGE_SAVE_WINDOW = 10;

/* ------------------------------------------------------------------- track */

interface Roof {
    id: number;
    x0: number;
    x1: number;
    top: number;
}

type ObstacleKind = "vent" | "ac" | "antenna" | "billboard";

interface Obstacle {
    id: number;
    roofId: number;
    x: number;
    w: number;
    h: number;
    top: number;
    kind: ObstacleKind;
    dead: boolean;
    /** Near-miss bookkeeping: tightest airborne clearance while overlapping. */
    minClearance: number;
    overlapped: boolean;
    resolved: boolean;
}

interface Cell {
    id: number;
    x: number;
    y: number;
    taken: boolean;
}

interface PowerupDrop {
    id: number;
    x: number;
    y: number;
    kind: PowerupKind;
    taken: boolean;
}

/** How far ahead of the camera the world exists, and how far behind it dies. */
const GENERATE_AHEAD = 2400;
const RECYCLE_BEHIND = 700;
/** The guaranteed clean runway opening every run (§8). */
const RUNWAY_LENGTH = 600;
const RUNWAY_TOP = 520;

export class RunnerCore {
    private seed = 0;
    private upgrades: UpgradeLevels;
    private rng = new NoiseRandom(1, 0);
    private phase: RunnerPhase = "ready";
    private time = 0;
    private accumulator = 0;

    private x = 0;
    private y = RUNWAY_TOP;
    private vy = 0;
    private grounded = true;
    private held = false;
    private coyote = 0;
    private jumpBuffer = 0;
    private invulnerable = 0;
    private stumbling = 0;
    private wallSliding = false;
    private airJumpReady = false;

    private startX = 0;
    private distance = 0;
    private speedTier = 0;
    private scoreAccumulator = 0;
    private flowPoints = 0;
    private flowTier = 1;
    private cellsThisRun = 0;
    private pickupChain = 0;
    private stumbles = 0;
    private nearMisses = 0;
    private smashes = 0;

    private power: ActivePowerup | null = null;
    private mobility: ActivePowerup | null = null;
    private lastPowerupKind: PowerupKind | null = null;

    private roofs: Roof[] = [];
    private obstacles: Obstacle[] = [];
    private cells: Cell[] = [];
    private powerups: PowerupDrop[] = [];
    private nextId = 1;
    private generatedTo = 0;
    private lastRoofTop = RUNWAY_TOP;
    private nextPowerupAtMetres = 0;

    private readonly events: RunnerEvent[] = [];

    constructor(opts: { seed: number; upgrades: UpgradeLevels }) {
        this.upgrades = { ...opts.upgrades };
        this.reset(opts);
    }

    reset(opts: { seed: number; upgrades: UpgradeLevels }): void {
        this.seed = opts.seed >>> 0;
        this.upgrades = { ...opts.upgrades };
        this.rng = new NoiseRandom(this.seed, 0);
        this.phase = "running";
        this.time = 0;
        this.accumulator = 0;

        // HEAD START drops the runner 250 m per level down the track (§10);
        // speed follows distance, so the matching tier comes for free.
        this.startX = this.upgrades.headStart * TIER_METRES * UNITS_PER_METRE;
        this.x = this.startX;
        this.y = RUNWAY_TOP;
        this.vy = 0;
        this.grounded = true;
        this.held = false;
        this.coyote = COYOTE_SECONDS;
        this.jumpBuffer = 0;
        this.invulnerable = 0;
        this.stumbling = 0;
        this.wallSliding = false;
        this.airJumpReady = false;

        this.distance = this.startX / UNITS_PER_METRE;
        this.speedTier = tierForDistance(this.distance);
        this.scoreAccumulator = 0;
        this.flowPoints = 0;
        this.flowTier = 1;
        this.cellsThisRun = 0;
        this.pickupChain = 0;
        this.stumbles = 0;
        this.nearMisses = 0;
        this.smashes = 0;

        this.power = null;
        this.mobility = null;
        this.lastPowerupKind = null;

        this.roofs = [];
        this.obstacles = [];
        this.cells = [];
        this.powerups = [];
        this.nextId = 1;
        this.lastRoofTop = RUNWAY_TOP;
        this.events.length = 0;

        // The runway: stable footing under the spawn, no clutter, no gaps (§8).
        const runway: Roof = {
            id: this.nextId++,
            x0: this.startX - 400,
            x1: this.startX + RUNWAY_LENGTH,
            top: RUNWAY_TOP,
        };
        this.roofs.push(runway);
        this.generatedTo = runway.x1;
        this.nextPowerupAtMetres = this.distance + this.rng.int(190, 321, 7) / (1 + 0.15 * this.upgrades.luckyCoil);
        this.generateAhead();
    }

    setHeld(held: boolean): void {
        if (held && !this.held) this.jumpBuffer = JUMP_BUFFER_SECONDS;
        this.held = held;
    }

    pause(): void {
        if (this.phase === "running" || this.phase === "ready") this.phase = "paused";
    }

    resume(): void {
        if (this.phase === "paused") this.phase = "running";
    }

    /** SECOND WIND: reboot on the nearest roof at 60% speed, 2 s invulnerable. */
    revive(): void {
        if (this.phase !== "dead") return;
        let landing = this.roofs.find((roof) => roof.x1 > this.x + RUNNER_WIDTH) ?? this.roofs[this.roofs.length - 1];
        if (!landing) return;
        // Reboot with room to read the roof: never on its last 200 units.
        for (const roof of this.roofs) {
            if (roof.x1 > this.x && roof.x1 - Math.max(this.x, roof.x0) > 200) {
                landing = roof;
                break;
            }
        }
        this.phase = "running";
        this.x = Math.max(this.x, landing.x0 + 80);
        this.y = landing.top;
        this.vy = 0;
        this.grounded = true;
        this.wallSliding = false;
        this.coyote = COYOTE_SECONDS;
        this.jumpBuffer = 0;
        this.invulnerable = 2;
        // 60% speed reads as the reboot cost; the stumble ramp brings it back.
        this.stumbling = STUMBLE_RECOVERY_SECONDS * 0.9;
        this.events.push({ type: "revive" });
    }

    update(dtSeconds: number): void {
        if (this.phase !== "running") return;
        const scale = this.power?.kind === "focus" ? FOCUS_TIME_SCALE : 1;
        this.accumulator += Math.max(0, Math.min(0.1, dtSeconds)) * scale;
        while (this.accumulator >= FIXED_DT) {
            this.accumulator -= FIXED_DT;
            this.step(FIXED_DT);
            if (this.phase !== "running") break;
        }
    }

    /* ------------------------------------------------------------------ step */

    private step(dt: number): void {
        this.time += dt;
        this.coyote = this.grounded ? COYOTE_SECONDS : Math.max(0, this.coyote - dt);
        this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
        this.invulnerable = Math.max(0, this.invulnerable - dt);
        this.stumbling = Math.max(0, this.stumbling - dt);
        this.tickPowerups(dt);

        // A buffered press inside coyote time jumps, even a hair after an edge.
        if (this.jumpBuffer > 0) {
            if (this.grounded || this.coyote > 0) {
                this.vy = -JUMP_IMPULSE;
                this.grounded = false;
                this.coyote = 0;
                this.jumpBuffer = 0;
                this.events.push({ type: "jump" });
            } else if (this.mobility?.kind === "jets" && this.airJumpReady) {
                // JET BOOTS: one mid-air jump, rearmed by landing (§9).
                this.vy = -JUMP_IMPULSE * 0.92;
                this.airJumpReady = false;
                this.jumpBuffer = 0;
                this.events.push({ type: "doubleJump" });
            }
        }

        // Gravity split: a released jump cuts short, a held one carries (§3).
        if (!this.grounded) {
            const gravity = this.vy < 0 ? (this.held ? GRAVITY_RISING_HELD : GRAVITY_RISING_RELEASED) : GRAVITY_FALLING;
            this.vy = Math.min(this.vy + gravity * dt, TERMINAL_FALL);
            this.y += this.vy * dt;
        }

        const speed = this.currentSpeed();
        const previousX = this.x;
        this.x += speed * dt;
        this.wallSliding = false;

        this.resolveRoofs(previousX);
        if (this.phase !== "running") return;
        this.resolveObstacles();
        if (this.phase !== "running") return;
        this.collectCells(dt);
        this.collectPowerups();

        const metres = this.x / UNITS_PER_METRE;
        // Distance and its score only accrue forward of the head-start line.
        if (metres > this.distance) {
            const gained = metres - this.distance;
            this.distance = metres;
            this.scoreAccumulator += gained * this.flowTier * this.scoreBoost();
        }
        const tier = tierForDistance(this.distance);
        if (tier !== this.speedTier) {
            this.speedTier = tier;
            this.events.push({ type: "speedTier", tier });
        }

        if (this.y > KILL_PLANE) {
            this.die("fall");
            return;
        }
        this.generateAhead();
        this.recycleBehind();
    }

    private currentSpeed(): number {
        let speed = speedForDistance(this.distance);
        if (this.stumbling > 0) {
            // ×0.45 at the moment of impact, easing back to full over the ramp.
            const recovery = 1 - this.stumbling / STUMBLE_RECOVERY_SECONDS;
            speed *= STUMBLE_SPEED_FACTOR + (1 - STUMBLE_SPEED_FACTOR) * recovery;
        }
        if (this.power?.kind === "rush") speed *= RUSH_SPEED_BONUS;
        return speed;
    }

    private scoreBoost(): number {
        return this.power?.kind === "rush" ? RUSH_SCORE_MULT : 1;
    }

    private tickPowerups(dt: number): void {
        if (this.power) {
            this.power.remaining -= dt;
            if (this.power.remaining <= 0) {
                this.events.push({ type: "powerupEnd", kind: this.power.kind });
                this.power = null;
            }
        }
        if (this.mobility) {
            this.mobility.remaining -= dt;
            if (this.mobility.remaining <= 0) {
                this.events.push({ type: "powerupEnd", kind: this.mobility.kind });
                this.mobility = null;
                this.airJumpReady = false;
            }
        }
    }

    /* ----------------------------------------------------------- collisions */

    private roofUnder(x: number): Roof | null {
        for (const roof of this.roofs) {
            if (x >= roof.x0 && x <= roof.x1) return roof;
        }
        return null;
    }

    private resolveRoofs(previousX: number): void {
        const half = RUNNER_WIDTH / 2;

        // Wall check: the runner's face against the rise of the roof ahead.
        // Sliding down a wall is not death by itself — the gap below is.
        for (const roof of this.roofs) {
            // >= keeps a pinned runner pinned on the following step too.
            if (roof.x0 >= previousX + half && roof.x0 <= this.x + half && this.y > roof.top + 6) {
                this.x = roof.x0 - half;
                this.wallSliding = true;
                if (this.grounded) this.grounded = false;
                break;
            }
        }

        if (this.grounded) {
            const roof = this.roofUnder(this.x);
            if (!roof || this.y < roof.top - 1) {
                // Ran off the edge: coyote time starts counting.
                this.grounded = false;
                if (roof) this.y = roof.top;
            } else {
                this.y = roof.top;
            }
            return;
        }

        // Landing: falling across a roof top inside its span this step.
        if (this.vy > 0) {
            const roof = this.roofUnder(this.x);
            if (roof && this.y >= roof.top && this.y - this.vy * FIXED_DT <= roof.top + 1) {
                const impact = this.vy;
                this.y = roof.top;
                this.vy = 0;
                this.grounded = true;
                this.airJumpReady = this.mobility?.kind === "jets";
                if (this.x - half < roof.x0 + EDGE_SAVE_WINDOW) {
                    this.events.push({ type: "edgeSave" });
                }
                this.events.push({ type: "land", impact });
                this.addFlowPoints(1);
            }
        }
    }

    private resolveObstacles(): void {
        const half = RUNNER_WIDTH / 2;
        const left = this.x - half;
        const right = this.x + half;
        const feet = this.y;
        const head = this.y - RUNNER_HEIGHT;

        for (const obstacle of this.obstacles) {
            if (obstacle.dead || obstacle.resolved) continue;
            const obsLeft = obstacle.x;
            const obsRight = obstacle.x + obstacle.w;
            const overlapsX = right > obsLeft && left < obsRight;

            if (overlapsX) {
                obstacle.overlapped = true;
                const clearance = obstacle.top - feet;
                if (clearance >= 0) {
                    obstacle.minClearance = Math.min(obstacle.minClearance, clearance);
                } else if (head < obstacle.top + obstacle.h && feet > obstacle.top) {
                    // Body and box intersect.
                    if (this.power?.kind === "overdrive") {
                        this.smash(obstacle);
                    } else if (this.invulnerable > 0) {
                        obstacle.resolved = true;
                    } else if (obstacle.kind === "billboard") {
                        this.die("billboard");
                        return;
                    } else {
                        this.stumble(obstacle);
                    }
                    continue;
                }
            } else if (obstacle.overlapped && left > obsRight) {
                // Cleanly passed: a tight clearance while airborne is a near-miss.
                obstacle.resolved = true;
                if (obstacle.minClearance <= NEAR_MISS_CLEARANCE) {
                    this.nearMisses += 1;
                    this.scoreAccumulator += SCORE_NEAR_MISS * this.flowTier * this.scoreBoost();
                    this.addFlowPoints(2);
                    this.events.push({ type: "nearMiss" });
                }
            }
        }
    }

    private stumble(obstacle: Obstacle): void {
        obstacle.dead = true;
        obstacle.resolved = true;
        this.stumbles += 1;
        this.stumbling = STUMBLE_RECOVERY_SECONDS;
        this.invulnerable = STUMBLE_INVULN_SECONDS;
        this.pickupChain = 0;
        // Flow resets to ×1 and zero points (§5).
        this.flowTier = 1;
        this.flowPoints = 0;
        this.events.push({ type: "stumble" });
    }

    private smash(obstacle: Obstacle): void {
        obstacle.dead = true;
        obstacle.resolved = true;
        this.smashes += 1;
        const billboard = obstacle.kind === "billboard";
        this.scoreAccumulator += (billboard ? SCORE_SMASH_BILLBOARD : SCORE_SMASH) * this.flowTier * this.scoreBoost();
        if (billboard) this.addFlowPoints(1);
        this.events.push({ type: "smash", billboard });
    }

    private collectCells(dt: number): void {
        const magnet = this.power?.kind === "magnet";
        const radius = MAGNET_BASE_RADIUS * (1 + 0.2 * this.upgrades.magnetCore);
        const centreY = this.y - RUNNER_HEIGHT / 2;
        for (const cell of this.cells) {
            if (cell.taken) continue;
            const dx = cell.x - this.x;
            const dy = cell.y - centreY;
            const dist = Math.hypot(dx, dy);
            if (magnet && dist < radius && dist > 1) {
                // Cells stream toward the runner, faster the closer they get.
                const pull = (1100 + (1 - dist / radius) * 900) * dt;
                cell.x -= (dx / dist) * pull;
                cell.y -= (dy / dist) * pull;
            }
            if (dist < 34) {
                cell.taken = true;
                this.cellsThisRun += 1;
                this.pickupChain += 1;
                this.scoreAccumulator += SCORE_CELL * this.flowTier * this.scoreBoost();
                // A chain of 5+ without a stumble feeds flow (§5).
                if (this.pickupChain > 0 && this.pickupChain % 5 === 0) this.addFlowPoints(2);
                this.events.push({ type: "pickup", chain: this.pickupChain });
            }
        }
    }

    private collectPowerups(): void {
        const centreY = this.y - RUNNER_HEIGHT / 2;
        for (const drop of this.powerups) {
            if (drop.taken) continue;
            if (Math.hypot(drop.x - this.x, drop.y - centreY) > 46) continue;
            drop.taken = true;
            this.activatePowerup(drop.kind);
        }
    }

    private activatePowerup(kind: PowerupKind): void {
        const total = POWERUP_BASE_SECONDS[kind] * (1 + 0.12 * this.upgrades.capacitor);
        if (kind === "jets") {
            // JETS lives in its own mobility slot and stacks with one power (§9).
            const previous = this.mobility;
            this.mobility = { kind, remaining: total, total };
            this.airJumpReady = true;
            this.events.push(
                previous ? { type: "powerupSwap", from: previous.kind, to: kind } : { type: "powerupStart", kind },
            );
            return;
        }
        const previous = this.power;
        this.power = { kind, remaining: total, total };
        this.events.push(
            previous ? { type: "powerupSwap", from: previous.kind, to: kind } : { type: "powerupStart", kind },
        );
    }

    private die(cause: "fall" | "billboard"): void {
        this.phase = "dead";
        this.grounded = false;
        this.events.push({ type: "death", cause });
    }

    private addFlowPoints(points: number): void {
        if (this.flowTier >= FLOW_MAX_TIER) return;
        // FLOW GRID: +10% flow points per level, rounded up per event (§10).
        const boosted = Math.ceil(points * (1 + 0.1 * this.upgrades.flowGrid));
        this.flowPoints += boosted;
        const threshold = FLOW_TIER_THRESHOLDS[this.flowTier - 1];
        if (threshold !== undefined && this.flowPoints >= threshold) {
            this.flowTier += 1;
            this.events.push({ type: "flowTier", tier: this.flowTier });
        }
    }

    /* ------------------------------------------------------------ generation */

    /**
     * Every roll is salted with the roof's world position so the stream is a
     * pure function of (seed, track position) — how far the player has run has
     * no bearing on what the generator deals next.
     */
    private generateAhead(): void {
        const horizon = this.x - CAMERA_ANCHOR_X + STAGE_WIDTH + GENERATE_AHEAD;
        let guard = 0;
        while (this.generatedTo < horizon && guard < 64) {
            guard += 1;
            this.appendSegment();
        }
    }

    private appendSegment(): void {
        const gapStart = this.generatedTo;
        const speed = speedForDistance(gapStart / UNITS_PER_METRE);
        const pace = paceForSpeed(speed);
        const salt = Math.round(gapStart) >>> 0;
        this.rng.setSeedAndPosition(this.seed, salt % 0xffff_0000);

        // Landing height first — the fairness cap depends on the rise.
        // Height steps taper past tier 8: at 900 u/s a ±160 step onto a
        // 240-length roof leaves no landable line (proven by the balance bot),
        // so the late game trades cliff drops for pace. DESIGN.md §7 carries
        // the same numbers.
        const stepMax = Math.round(knob(pace, 60, 100, 120));
        let top = this.lastRoofTop + this.rng.int(-stepMax, stepMax + 1, 1);
        top = Math.max(ROOF_TOP_MIN, Math.min(ROOF_TOP_MAX, top));

        // Gap width per §7, capped by the fairness contract: a full-held jump
        // at this tier's speed always clears it with margin. A rise that
        // squeezes the cap below the tier's minimum gap gets lowered instead.
        //
        // The gap MINIMUM climbs steeply with the tier: at 900 u/s even the
        // shortest tap flies ~570 u, so a 120 u gap in front of a short roof
        // is a trap — the smallest jump overflies the landing entirely. Big
        // speed needs big committed gaps, never stub hops.
        const gapMin = knob(pace, 60, 140, 200);
        // Cap-pace gaps stop short of the fairness cap's edge: with RUSH the
        // arrival-speed spread eats the widest gaps' landing margins.
        const gapMax = knob(pace, 140, 260, 340);
        const capFraction = knob(pace, 0.55, 0.62, 0.68);
        let cap = capFraction * heldJumpReach(speed, this.lastRoofTop - top);
        while (cap < gapMin && top < ROOF_TOP_MAX) {
            top = Math.min(ROOF_TOP_MAX, top + 24);
            cap = capFraction * heldJumpReach(speed, this.lastRoofTop - top);
        }
        const gap = Math.min(this.rng.float(gapMin, gapMax, 2), cap);

        // Roofs never shrink below what the smallest jump needs to land on
        // them after the pace's minimum gap (same trap as above) — and at cap
        // pace they LENGTHEN: with RUSH stacked on 920 u/s, landing windows
        // need the extra floor or every line turns razor.
        const lengthMin = knob(pace, 380, 400, 520);
        const lengthMax = knob(pace, 900, 800, 880);
        let length = this.rng.float(lengthMin, lengthMax, 3);

        // Billboard intent is decided before the roof is sized: the lethal
        // obstacle must always leave room to LAND after the leap that clears
        // it, so a billboard roof extends past the tier's length cap rather
        // than parking the wall next to the gap (fairness over the §7 table).
        const billboardChance = knob(pace, 0, 0.1, 0.18);
        const wantBillboard = this.rng.bool(billboardChance, 40);
        const billboardTail = 0.9 * heldJumpReach(speed, 0);
        if (wantBillboard) {
            length = Math.max(length, Math.max(140, 60 + speed * 0.26) + 92 + billboardTail + 80);
        }

        const roof: Roof = {
            id: this.nextId++,
            x0: gapStart + gap,
            x1: gapStart + gap + length,
            top,
        };
        this.roofs.push(roof);
        this.generatedTo = roof.x1;

        this.placeObstacles(roof, pace, wantBillboard, billboardTail);
        this.placeCells(roof, gap);
        this.placePowerup(roof);
        this.lastRoofTop = top;
    }

    private placeObstacles(roof: Roof, pace: number, wantBillboard: boolean, billboardTail: number): void {
        const length = roof.x1 - roof.x0;
        const usable = length - 280; // 140 u clean at both edges (§8)
        if (usable < 60) return;

        if (wantBillboard) {
            // One billboard, parked so the full clearing leap lands on THIS
            // roof: never closer to the far edge than the jump's tail, and
            // never so close to the leading edge that a runner arriving off
            // the gap has no room to rise over it at this tier's speed.
            const w = this.rng.int(70, 92, 10);
            const h = this.rng.int(110, 150, 11);
            // Lead-in covers the WORST arrival: the far end of the roof's
            // speed range with an active RUSH on top.
            const speed = speedForDistance(roof.x0 / UNITS_PER_METRE) * 1.12;
            const leadIn = Math.max(140, 60 + speed * 0.26);
            const maxX = roof.x1 - billboardTail - w;
            if (maxX > roof.x0 + leadIn) {
                const x = roof.x0 + leadIn + this.rng.float(0, maxX - roof.x0 - leadIn, 12);
                this.obstacles.push({
                    id: this.nextId++,
                    roofId: roof.id,
                    x,
                    w,
                    h,
                    top: roof.top - h,
                    kind: "billboard",
                    dead: false,
                    minClearance: Number.POSITIVE_INFINITY,
                    overlapped: false,
                    resolved: false,
                });
            }
            return;
        }

        const chance = knob(pace, 0.35, 0.6, 0.8);
        if (!this.rng.bool(chance, 4)) return;
        const count = usable > 420 && this.rng.bool(0.4, 6) ? 2 : 1;

        let cursor = roof.x0 + 140;
        for (let index = 0; index < count; index += 1) {
            const zone = usable / count;
            const kind: ObstacleKind = (["vent", "ac", "antenna"] as const)[this.rng.int(0, 3, 8 + index)] ?? "vent";
            let w: number;
            let h: number;
            if (kind === "vent") {
                w = this.rng.int(34, 47, 10 + index);
                h = this.rng.int(28, 41, 11 + index);
            } else if (kind === "ac") {
                w = this.rng.int(44, 61, 10 + index);
                h = this.rng.int(40, 65, 11 + index);
            } else {
                w = this.rng.int(10, 17, 10 + index);
                h = this.rng.int(64, 97, 11 + index);
            }
            const slack = Math.max(0, zone - w - 40);
            const x = cursor + this.rng.float(0, slack, 12 + index);
            // The §8 contract: clutter never sits within 140 u of either roof
            // edge. The cursor walk can push a SECOND obstacle past that line.
            if (x + w > roof.x1 - 140) break;
            this.obstacles.push({
                id: this.nextId++,
                roofId: roof.id,
                x,
                w,
                h,
                top: roof.top - h,
                kind,
                dead: false,
                minClearance: Number.POSITIVE_INFINITY,
                overlapped: false,
                resolved: false,
            });
            cursor = x + w + 180;
            if (cursor > roof.x0 + 140 + usable) break;
        }
    }

    private placeCells(roof: Roof, gap: number): void {
        // Every wide gap earns an arc tracing the jump that clears it (§8):
        // following a cell line is always a survivable line.
        if (gap >= 180) {
            const takeoffX = roof.x0 - gap;
            const takeoffTop = this.lastRoofTop;
            const speed = speedForDistance(takeoffX / UNITS_PER_METRE);
            const count = 5 + this.rng.int(0, 3, 20);
            for (let index = 0; index < count; index += 1) {
                const progress = (index + 1) / (count + 1);
                const worldX = takeoffX + gap * progress;
                const arcT = (gap * progress) / speed;
                this.cells.push({
                    id: this.nextId++,
                    x: worldX,
                    y: takeoffTop - RUNNER_HEIGHT / 2 - this.heldJumpHeightAt(arcT),
                    taken: false,
                });
            }
        }

        if (!this.rng.bool(0.55, 21)) return;
        const length = roof.x1 - roof.x0;
        if (length < 360) return;
        const count = this.rng.int(4, 10, 22);
        const spacing = 44;
        const span = (count - 1) * spacing;
        const start = roof.x0 + 150 + this.rng.float(0, Math.max(0, length - 300 - span), 23);
        for (let index = 0; index < count; index += 1) {
            const x = start + index * spacing;
            // Cells never sit inside a hazard's lane.
            const blocked = this.obstacles.some(
                (obstacle) => obstacle.roofId === roof.id && x > obstacle.x - 70 && x < obstacle.x + obstacle.w + 70,
            );
            if (blocked) continue;
            const lift = Math.sin((index / Math.max(1, count - 1)) * Math.PI) * 26;
            this.cells.push({
                id: this.nextId++,
                x,
                y: roof.top - 46 - lift,
                taken: false,
            });
        }
    }

    /** Vertical offset above takeoff height `t` seconds into a full-held jump. */
    private heldJumpHeightAt(t: number): number {
        let y = 0;
        let vy = -JUMP_IMPULSE;
        const step = 1 / 240;
        for (let elapsed = 0; elapsed < t; elapsed += step) {
            const gravity = vy < 0 ? GRAVITY_RISING_HELD : GRAVITY_FALLING;
            vy = Math.min(vy + gravity * step, TERMINAL_FALL);
            y += vy * step;
        }
        return Math.max(-40, -y);
    }

    private placePowerup(roof: Roof): void {
        const roofStartMetres = roof.x0 / UNITS_PER_METRE;
        if (roofStartMetres < this.nextPowerupAtMetres) return;
        const length = roof.x1 - roof.x0;
        if (length < 320) return;
        const x = roof.x0 + length * 0.55;
        // A pedestal never shares its spot with clutter.
        const blocked = this.obstacles.some(
            (obstacle) => obstacle.roofId === roof.id && x > obstacle.x - 120 && x < obstacle.x + obstacle.w + 120,
        );
        if (blocked) return;
        const kinds = POWERUP_KINDS.filter((kind) => kind !== this.lastPowerupKind);
        const kind = kinds[this.rng.int(0, kinds.length, 30)] ?? "magnet";
        this.powerups.push({
            id: this.nextId++,
            x,
            y: roof.top - 52,
            kind,
            taken: false,
        });
        this.lastPowerupKind = kind;
        this.nextPowerupAtMetres = roofStartMetres + this.rng.int(190, 321, 31) / (1 + 0.15 * this.upgrades.luckyCoil);
    }

    private recycleBehind(): void {
        const cutoff = this.x - CAMERA_ANCHOR_X - RECYCLE_BEHIND;
        if (this.roofs.length > 0 && this.roofs[0] && this.roofs[0].x1 < cutoff) this.roofs.shift();
        this.obstacles = this.obstacles.filter((obstacle) => obstacle.x + obstacle.w >= cutoff);
        this.cells = this.cells.filter((cell) => !cell.taken && cell.x >= cutoff);
        this.powerups = this.powerups.filter((drop) => !drop.taken && drop.x >= cutoff);
    }

    /* -------------------------------------------------------------- snapshot */

    snapshot(): RunnerSnapshot {
        const cameraX = this.x - CAMERA_ANCHOR_X;
        const viewMin = cameraX - 400;
        const viewMax = cameraX + STAGE_WIDTH + 900;
        return {
            phase: this.phase,
            time: this.time,
            runner: {
                x: this.x,
                y: this.y,
                vy: this.vy,
                grounded: this.grounded,
                holdingJump: this.held,
                speed: this.currentSpeed(),
                invulnerable: this.invulnerable,
                stumbling: this.stumbling,
                wallSliding: this.wallSliding,
            },
            camera: { x: cameraX },
            distance: Math.floor(this.distance - this.startX / UNITS_PER_METRE),
            speedTier: this.speedTier,
            score: Math.floor(this.scoreAccumulator),
            flow: {
                tier: this.flowTier,
                points: this.flowPoints,
                nextAt: FLOW_TIER_THRESHOLDS[Math.min(this.flowTier - 1, FLOW_TIER_THRESHOLDS.length - 1)] ?? 26,
            },
            cellsThisRun: this.cellsThisRun,
            pickupChain: this.pickupChain,
            stumbles: this.stumbles,
            nearMisses: this.nearMisses,
            smashes: this.smashes,
            power: this.power ? { ...this.power } : null,
            mobility: this.mobility ? { ...this.mobility } : null,
            timeScale: this.power?.kind === "focus" ? FOCUS_TIME_SCALE : 1,
            world: {
                roofs: this.roofs
                    .filter((roof) => roof.x1 >= viewMin && roof.x0 <= viewMax)
                    .map((roof) => ({ x0: roof.x0, x1: roof.x1, top: roof.top })),
                obstacles: this.obstacles
                    .filter((obstacle) => obstacle.x + obstacle.w >= viewMin && obstacle.x <= viewMax)
                    .map((obstacle) => ({
                        id: obstacle.id,
                        x: obstacle.x,
                        top: obstacle.top,
                        w: obstacle.w,
                        h: obstacle.h,
                        kind: obstacle.kind,
                        dead: obstacle.dead,
                    })),
                cells: this.cells
                    .filter((cell) => !cell.taken && cell.x >= viewMin && cell.x <= viewMax)
                    .map((cell) => ({ id: cell.id, x: cell.x, y: cell.y, taken: cell.taken })),
                powerups: this.powerups
                    .filter((drop) => !drop.taken && drop.x >= viewMin && drop.x <= viewMax)
                    .map((drop) => ({ id: drop.id, x: drop.x, y: drop.y, kind: drop.kind, taken: drop.taken })),
            },
        };
    }

    drainEvents(): RunnerEvent[] {
        return this.events.splice(0, this.events.length);
    }
}
