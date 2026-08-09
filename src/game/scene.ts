// NEONLEAP renderer — "Neon Silhouette" (DESIGN.md §12).
//
// The world is a stack of parallax silhouettes under a dusk gradient; the
// gameplay roofline is near-black with a glowing cyan rim, and the runner is
// the brightest thing on screen. Everything here is generated at boot from
// code (canvas-baked gradients and glows) — no image ships with the game.
//
// Renderer rules learned the hard way (see memory):
// - Additive light needs a tinted Sprite over a soft canvas texture; a
//   Graphics with blendMode "add" renders nothing.
// - Gradients come from a 1×256 canvas strip, never stacked translucent bands.
// - Glow textures pad to transparent before their edge so they never clip flat.

import { Application, Container, Graphics, Sprite, Text, TextStyle, Texture, TilingSprite } from "pixi.js";
import { NoiseRandom } from "./noiseRandom.ts";
import {
    KILL_PLANE,
    type PowerupKind,
    ROOF_TOP_MAX,
    RUNNER_HEIGHT,
    RUNNER_WIDTH,
    type RunnerEvent,
    type RunnerSnapshot,
    STAGE_HEIGHT,
    STAGE_WIDTH,
} from "./core.ts";
import { createPixiApp } from "./pixiApp.ts";

/* --------------------------------------------------------------- palette §12 */

const SKY_UPPER = 0x0b1026;
const HORIZON_BLOOM = 0x3d2a6e;
const SKYLINE = 0x05070f;
const FACE_WINDOW_WARM = 0xffd9a0;
const FACE_WINDOW_COOL = 0x9fd8ff;
const CYAN = 0x3df5ff;
const MAGENTA = 0xff3df0;
const AMBER = 0xffb347;
const VIOLET = 0x9b5cff;
const GREEN = 0x52ffa8;
const RUNNER_BODY = 0xeaf2ff;
const RAIN = 0x9fd8ff;

export const POWERUP_COLORS: Readonly<Record<PowerupKind, number>> = {
    overdrive: AMBER,
    magnet: CYAN,
    focus: VIOLET,
    rush: MAGENTA,
    jets: GREEN,
};

export const POWERUP_LABELS: Readonly<Record<PowerupKind, string>> = {
    overdrive: "OVERDRIVE",
    magnet: "MAGNET",
    focus: "FOCUS",
    rush: "RUSH",
    jets: "JET BOOTS",
};

/** Depth buckets for batching the rain into a few stroke calls. */
const RAIN_DEPTH_BUCKETS = 4;

const HUD_FONT = '"Avenir Next Condensed", "Arial Narrow", Impact, Haettenschweiler, system-ui, sans-serif';

/**
 * The city rolls through DISTRICTS every 800 m: the rim light, signage and
 * rooftop furniture change character so a long run keeps offering new things
 * to look at. Gameplay colours (cells, powerups, hazard amber) never change.
 */
const DISTRICT_METRES = 800;
const DISTRICTS: readonly { accent: number; second: number; windowChance: number }[] = [
    { accent: CYAN, second: MAGENTA, windowChance: 0.2 }, // harbor neon
    { accent: MAGENTA, second: AMBER, windowChance: 0.3 }, // signage quarter
    { accent: AMBER, second: GREEN, windowChance: 0.14 }, // sodium industrial
    { accent: VIOLET, second: CYAN, windowChance: 0.24 }, // uptown violet
    { accent: GREEN, second: MAGENTA, windowChance: 0.32 }, // park grid
];

function districtAt(worldX: number): { index: number; accent: number; second: number; windowChance: number } {
    const index = Math.max(0, Math.floor(worldX / (DISTRICT_METRES * 10))) % DISTRICTS.length;
    const district = DISTRICTS[index] ?? DISTRICTS[0];
    if (!district) throw new Error("district table empty");
    return { index, ...district };
}

/** Per-channel colour lerp for smooth ambience transitions. */
function mixColor(from: number, to: number, t: number): number {
    const fr = (from >> 16) & 0xff;
    const fg = (from >> 8) & 0xff;
    const fb = from & 0xff;
    const tr = (to >> 16) & 0xff;
    const tg = (to >> 8) & 0xff;
    const tb = to & 0xff;
    return (
        (Math.round(fr + (tr - fr) * t) << 16) | (Math.round(fg + (tg - fg) * t) << 8) | Math.round(fb + (tb - fb) * t)
    );
}

/* ------------------------------------------------------------------ helpers */

/** Deterministic -1..1 hash for cosmetic jitter (never gameplay). */
function jitter(key: number): number {
    return (NoiseRandom.randomize(0x9e37, key >>> 0) / NoiseRandom.MAX_UINT32) * 2 - 1;
}

function hash01(key: number): number {
    return NoiseRandom.randomize(0x51ed, key >>> 0) / NoiseRandom.MAX_UINT32;
}

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2d context unavailable");
    return [canvas, context];
}

/** Vertical 1×256 gradient strip — the banding-free way to paint a ramp. */
function gradientTexture(stops: readonly [number, string][]): Texture {
    const [canvas, ctx] = makeCanvas(1, 256);
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1, 256);
    return Texture.from(canvas);
}

/** Soft radial glow, faded to nothing well inside the bitmap edge. */
function glowTexture(size = 160): Texture {
    const [canvas, ctx] = makeCanvas(size, size);
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half * 0.94);
    gradient.addColorStop(0, "rgba(255,255,255,0.85)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.32)");
    gradient.addColorStop(0.7, "rgba(255,255,255,0.08)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return Texture.from(canvas);
}

/** Horizontal light bar with soft vertical falloff and feathered ends. */
function glowBarTexture(width = 256, height = 48): Texture {
    const [canvas, ctx] = makeCanvas(width, height);
    const vertical = ctx.createLinearGradient(0, 0, 0, height);
    vertical.addColorStop(0, "rgba(255,255,255,0)");
    vertical.addColorStop(0.5, "rgba(255,255,255,0.55)");
    vertical.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = vertical;
    ctx.fillRect(0, 0, width, height);
    const ends = ctx.createLinearGradient(0, 0, width, 0);
    ends.addColorStop(0, "rgba(0,0,0,1)");
    ends.addColorStop(0.12, "rgba(0,0,0,0)");
    ends.addColorStop(0.88, "rgba(0,0,0,0)");
    ends.addColorStop(1, "rgba(0,0,0,1)");
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = ends;
    ctx.fillRect(0, 0, width, height);
    return Texture.from(canvas);
}

/** Screen-edge vignette baked once: transparent middle, near-black rim. */
function vignetteTexture(size = 256): Texture {
    const [canvas, ctx] = makeCanvas(size, size);
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, half * 0.42, half, half, half * 1.02);
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(0.72, "rgba(0,0,0,0.18)");
    gradient.addColorStop(1, "rgba(0,0,0,0.62)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return Texture.from(canvas);
}

interface SkylineSpec {
    seed: number;
    tileWidth: number;
    height: number;
    baseColor: string;
    minH: number;
    maxH: number;
    minW: number;
    maxW: number;
    windows: boolean;
    signs: boolean;
}

/** Bakes one repeating silhouette strip for a parallax band. */
function skylineTexture(spec: SkylineSpec): Texture {
    const scale = 2;
    const [canvas, ctx] = makeCanvas(spec.tileWidth * scale, spec.height * scale);
    ctx.scale(scale, scale);
    const rng = new NoiseRandom(spec.seed, 0);
    ctx.fillStyle = spec.baseColor;
    let x = 0;
    const signPalette = ["#3DF5FF", "#FF3DF0", "#FFB347", "#9B5CFF", "#52FFA8"];
    while (x < spec.tileWidth) {
        const width = rng.int(spec.minW, spec.maxW);
        const height = rng.int(spec.minH, spec.maxH);
        const top = spec.height - height;
        ctx.fillStyle = spec.baseColor;
        ctx.fillRect(x, top, Math.min(width, spec.tileWidth - x), height);
        // Rooftop furniture: masts and water tanks read even as pure silhouette.
        if (rng.bool(0.4)) {
            const mastX = x + rng.int(4, Math.max(5, width - 4));
            ctx.fillRect(mastX, top - rng.int(6, 22), 2, 24);
        }
        if (rng.bool(0.25)) {
            const tankX = x + rng.int(2, Math.max(3, width - 12));
            ctx.fillRect(tankX, top - 8, 10, 8);
        }
        if (spec.windows) {
            for (let wy = top + 6; wy < spec.height - 8; wy += 9) {
                for (let wx = x + 3; wx < x + width - 4 && wx < spec.tileWidth - 3; wx += 7) {
                    const roll = rng.nextDouble();
                    if (roll < 0.16) {
                        ctx.fillStyle = roll < 0.03 ? "rgba(159,216,255,0.5)" : "rgba(255,217,160,0.4)";
                        ctx.fillRect(wx, wy, 2.4, 3.4);
                    }
                }
            }
        }
        if (spec.signs && width > 34 && rng.bool(0.38)) {
            const color = signPalette[rng.int(0, signPalette.length)] ?? "#3DF5FF";
            const signX = x + rng.int(4, Math.max(5, width - 22));
            const signY = top + rng.int(10, Math.max(11, Math.min(60, height - 20)));
            ctx.save();
            ctx.shadowColor = color;
            ctx.shadowBlur = 7;
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.85;
            if (rng.bool(0.5)) {
                // A vertical sign of glyph-like dashes.
                for (let seg = 0; seg < rng.int(3, 6); seg += 1) ctx.fillRect(signX, signY + seg * 9, 4, 6);
            } else {
                ctx.fillRect(signX, signY, rng.int(12, 26), 3);
                if (rng.bool(0.6)) ctx.fillRect(signX, signY + 5, rng.int(8, 18), 3);
            }
            ctx.restore();
        }
        x += width + rng.int(2, 14);
    }
    return Texture.from(canvas);
}

/* ----------------------------------------------------------------- pooling */

class SpritePool {
    private readonly sprites: Sprite[] = [];
    private index = 0;

    constructor(
        private readonly parent: Container,
        private readonly texture: Texture,
        private readonly additive: boolean,
    ) {}

    begin(): void {
        this.index = 0;
    }

    get(): Sprite {
        let sprite = this.sprites[this.index];
        if (!sprite) {
            sprite = new Sprite(this.texture);
            sprite.anchor.set(0.5);
            if (this.additive) sprite.blendMode = "add";
            this.sprites.push(sprite);
            this.parent.addChild(sprite);
        }
        this.index += 1;
        sprite.visible = true;
        return sprite;
    }

    end(): void {
        for (let i = this.index; i < this.sprites.length; i += 1) {
            const sprite = this.sprites[i];
            if (sprite) sprite.visible = false;
        }
    }
}

/* ---------------------------------------------------------------- particles */

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    size: number;
    color: number;
    gravity: number;
    drag: number;
    shard: boolean;
    spin: number;
    angle: number;
    glow: boolean;
}

interface RainDrop {
    x: number;
    y: number;
    depth: number;
}

interface Popup {
    text: Text;
    x: number;
    y: number;
    life: number;
    maxLife: number;
    rise: number;
}

interface PoseFrame {
    x: number;
    y: number;
    phase: number;
    grounded: boolean;
    vy: number;
}

export interface SceneViewport {
    width: number;
    height: number;
    scale: number;
    /** Visible width in design units — landscape screens wider than 16:9 see more city. */
    designWidth: number;
    orientation: "landscape" | "portrait";
}

/* ------------------------------------------------------------------- scene */

export class GameScene {
    readonly app: Application;
    private readonly host: HTMLElement;

    // Screen-space layers.
    private readonly skySprite: Sprite;
    private readonly horizonGlow: Sprite;
    private readonly moonGlow: Sprite;
    private readonly moon: Graphics = new Graphics();
    private readonly starGraphics = new Graphics();
    private farLayer: TilingSprite;
    private midLayer: TilingSprite;
    private nearLayer: TilingSprite;
    private readonly rainGraphics = new Graphics();
    private readonly vignette: Sprite;
    private readonly focusVignette: Sprite;
    private readonly speedLineGraphics = new Graphics();
    private readonly flashGraphics = new Graphics();

    // World-space (scrolls with the camera).
    private readonly stage = new Container();
    private readonly world = new Container();
    private readonly buildingGraphics = new Graphics();
    private readonly rimGraphics = new Graphics();
    private readonly propGraphics = new Graphics();
    private readonly cellGraphics = new Graphics();
    private readonly ghostGraphics = new Graphics();
    private readonly runnerGraphics = new Graphics();
    private readonly scarfGraphics = new Graphics();
    private readonly auraGraphics = new Graphics();
    private readonly particleGraphics = new Graphics();
    private readonly popupLayer = new Container();

    private readonly glowPool: SpritePool;
    private readonly barPool: SpritePool;

    private viewport: SceneViewport;
    private resizeObserver: ResizeObserver | null = null;
    private resizeFrame = 0;

    private reducedMotion = false;
    private mode: "menu" | "run" = "menu";
    /** NEON CORE cosmetic: the scarf and trail run ion-white instead of magenta. */
    private ionTrail = false;
    private time = 0;
    private menuDrift = 0;
    private cameraX = 0;
    private cameraY = 0;
    private shake = 0;
    private shakeX = 0;
    private shakeY = 0;
    private flash = 0;
    private flashColor = 0xffffff;
    private zoomPulse = 0;
    private deathT = -1;
    private deathCause: "fall" | "billboard" | null = null;
    private landSquash = 0;
    private jumpStretch = 0;
    private stars: { x: number; y: number; size: number; speed: number; warm: boolean }[] = [];
    private particles: Particle[] = [];
    private rain: RainDrop[] = [];
    private popups: Popup[] = [];
    private popupTextPool: Text[] = [];
    private scarfPoints: { x: number; y: number }[] = [];
    private poseHistory: PoseFrame[] = [];
    private poseTimer = 0;
    private runPhase = 0;
    private runStep = 0;
    /** Expanding landing shockwaves, in world space. */
    private rings: { x: number; y: number; t: number; strength: number }[] = [];
    /** Perched pigeon flocks, keyed by their roof's x0. */
    private readonly birdFlocks = new Map<number, { x: number; y: number; count: number; scaredAt: number }>();
    /** Rain is drawn in a few depth buckets, one stroke each (see drawRain). */
    private readonly rainBuckets: number[][] = Array.from({ length: RAIN_DEPTH_BUCKETS }, () => []);
    private citySignature = "";
    private flickerWindows: { x: number; y: number; color: number; key: number }[] = [];
    private phaseMs: Record<string, number> = {};
    private phaseFrames = 0;
    private ambienceTint = HORIZON_BLOOM;
    private nextLightningAt = 8;
    private lightningT = -1;
    private lightningX = 0.5;
    private lightningFlash = 0;
    private hazeSprite: Sprite;

    private constructor(app: Application, host: HTMLElement) {
        this.app = app;
        this.host = host;
        this.viewport = this.measure();

        const glow = glowTexture();
        const bar = glowBarTexture();

        this.skySprite = new Sprite(
            gradientTexture([
                [0, "#05070F"],
                [0.42, "#0B1026"],
                [0.8, "#1B2242"],
                [1, "#232A52"],
            ]),
        );
        this.horizonGlow = new Sprite(glow);
        this.horizonGlow.anchor.set(0.5);
        this.horizonGlow.blendMode = "add";
        this.horizonGlow.tint = HORIZON_BLOOM;

        this.moonGlow = new Sprite(glow);
        this.moonGlow.anchor.set(0.5);
        this.moonGlow.blendMode = "add";
        this.moonGlow.tint = 0xcfe4ff;

        this.farLayer = this.buildLayer("far");
        this.midLayer = this.buildLayer("mid");
        this.nearLayer = this.buildLayer("near");

        // Atmospheric haze between the parallax city and the play layer: the
        // background lifts toward the sky colour, so the near-black gameplay
        // silhouettes pop instead of melting into the skyline.
        this.hazeSprite = new Sprite(
            gradientTexture([
                [0, "rgba(35,42,82,0)"],
                [0.55, "rgba(35,42,82,0.34)"],
                [1, "rgba(43,52,100,0.6)"],
            ]),
        );

        this.vignette = new Sprite(vignetteTexture());
        this.focusVignette = new Sprite(glowTexture(200));
        this.focusVignette.anchor.set(0.5);
        this.focusVignette.blendMode = "add";
        this.focusVignette.tint = VIOLET;
        this.focusVignette.alpha = 0;

        this.world.addChild(
            this.buildingGraphics,
            this.rimGraphics,
            this.propGraphics,
            this.cellGraphics,
            this.ghostGraphics,
            this.scarfGraphics,
            this.runnerGraphics,
            this.auraGraphics,
            this.particleGraphics,
        );
        this.glowPool = new SpritePool(this.world, glow, true);
        this.barPool = new SpritePool(this.world, bar, true);
        this.world.addChild(this.popupLayer);

        this.stage.addChild(
            this.skySprite,
            this.starGraphics,
            this.moonGlow,
            this.moon,
            this.horizonGlow,
            this.farLayer,
            this.midLayer,
            this.nearLayer,
            this.hazeSprite,
            this.world,
            this.rainGraphics,
            this.vignette,
            this.focusVignette,
            this.speedLineGraphics,
            this.flashGraphics,
        );
        this.app.stage.addChild(this.stage);

        this.seedStars();
        this.seedRain();
        this.applyViewport();
        this.bindResize();
    }

    static async create(host: HTMLElement): Promise<GameScene> {
        const app = await createPixiApp(host);
        return new GameScene(app, host);
    }

    private buildLayer(band: "far" | "mid" | "near"): TilingSprite {
        const spec: SkylineSpec =
            band === "far"
                ? {
                      seed: 101,
                      tileWidth: 1024,
                      height: 340,
                      baseColor: "#141B3D",
                      minH: 90,
                      maxH: 330,
                      minW: 26,
                      maxW: 64,
                      windows: true,
                      signs: false,
                  }
                : band === "mid"
                  ? {
                        seed: 202,
                        tileWidth: 1024,
                        height: 300,
                        baseColor: "#0E1430",
                        minH: 70,
                        maxH: 285,
                        minW: 40,
                        maxW: 110,
                        windows: true,
                        signs: true,
                    }
                  : {
                        seed: 303,
                        tileWidth: 1024,
                        height: 240,
                        baseColor: "#090D22",
                        minH: 50,
                        maxH: 220,
                        minW: 60,
                        maxW: 150,
                        windows: false,
                        signs: false,
                    };
        const texture = skylineTexture(spec);
        const sprite = new TilingSprite({ texture, width: STAGE_WIDTH, height: spec.height });
        sprite.tileScale.set(0.5);
        return sprite;
    }

    /* -------------------------------------------------------------- viewport */

    getViewport(): Readonly<SceneViewport> {
        return this.viewport;
    }

    private measure(): SceneViewport {
        const width = Math.max(1, Math.round(this.host.clientWidth || window.innerWidth));
        const height = Math.max(1, Math.round(this.host.clientHeight || window.innerHeight));
        // Height-fit: the stage always shows the full 720-unit column and the
        // endless city simply extends sideways on wider screens — no letterbox.
        const scale = height / STAGE_HEIGHT;
        return {
            width,
            height,
            scale,
            designWidth: Math.min(2600, width / scale),
            orientation: width >= height ? "landscape" : "portrait",
        };
    }

    private applyViewport(): void {
        this.stage.scale.set(this.viewport.scale);
        const root = document.documentElement;
        root.dataset.orientation = this.viewport.orientation;
        root.style.setProperty("--ui-scale", String(this.viewport.scale));
        this.layoutStatic();
    }

    private layoutStatic(): void {
        const w = this.viewport.designWidth;
        this.skySprite.width = w;
        this.skySprite.height = STAGE_HEIGHT;
        this.horizonGlow.position.set(w * 0.62, 460);
        this.horizonGlow.scale.set(w / 90, 3.2);
        this.horizonGlow.alpha = 0.5;
        this.moon.clear();
        this.moon.circle(w * 0.78, 132, 34).fill({ color: 0xdfe9ff });
        this.moon.circle(w * 0.78 - 11, 124, 30).fill({ color: SKY_UPPER, alpha: 0.35 });
        this.moonGlow.position.set(w * 0.78, 132);
        this.moonGlow.scale.set(2.4);
        this.moonGlow.alpha = 0.5;
        this.farLayer.width = w;
        this.farLayer.position.set(0, 585 - 340);
        this.midLayer.width = w;
        this.midLayer.position.set(0, 634 - 300);
        this.nearLayer.width = w;
        this.nearLayer.position.set(0, 690 - 240);
        this.hazeSprite.width = w;
        this.hazeSprite.position.set(0, 350);
        this.hazeSprite.height = 350;
        this.vignette.position.set(0, 0);
        this.vignette.width = w;
        this.vignette.height = STAGE_HEIGHT;
        this.focusVignette.position.set(w / 2, STAGE_HEIGHT / 2);
        this.focusVignette.scale.set(w / 110, STAGE_HEIGHT / 110);
    }

    private bindResize(): void {
        const schedule = (): void => {
            window.cancelAnimationFrame(this.resizeFrame);
            this.resizeFrame = window.requestAnimationFrame(() => this.resize());
        };
        if (typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(schedule);
            this.resizeObserver.observe(this.host);
        }
        window.addEventListener("resize", schedule, { passive: true });
        window.addEventListener("orientationchange", schedule, { passive: true });
    }

    resize(): void {
        const next = this.measure();
        if (next.width === this.viewport.width && next.height === this.viewport.height) return;
        this.viewport = next;
        this.app.renderer.resize(next.width, next.height);
        this.applyViewport();
        this.seedStars();
        this.seedRain();
    }

    /* -------------------------------------------------------------- settings */

    setReducedMotion(enabled: boolean): void {
        this.reducedMotion = enabled;
        if (enabled) {
            this.shake = 0;
            this.zoomPulse = 0;
            this.poseHistory = [];
        }
        this.seedRain();
    }

    setIonTrail(enabled: boolean): void {
        this.ionTrail = enabled;
    }

    setMode(mode: "menu" | "run"): void {
        this.mode = mode;
        if (mode === "run") {
            this.deathT = -1;
            this.deathCause = null;
        }
    }

    /* ---------------------------------------------------------------- events */

    handleEvent(event: RunnerEvent, snapshot: RunnerSnapshot): void {
        const r = snapshot.runner;
        switch (event.type) {
            case "jump":
                this.jumpStretch = 1;
                this.spawnDust(r.x, r.y, 6, 0.8);
                break;
            case "doubleJump":
                this.jumpStretch = 1;
                this.spawnBurst(r.x, r.y - 8, GREEN, 10, 240, true);
                break;
            case "land":
                this.landSquash = Math.min(1, event.impact / 1100);
                this.spawnDust(r.x, r.y, 4 + Math.round(event.impact / 220), 1);
                if (!this.reducedMotion && event.impact > 320) {
                    this.rings.push({ x: r.x, y: r.y, t: 0, strength: Math.min(1, event.impact / 1400) });
                }
                if (event.impact > 900) this.addShake(2.2);
                break;
            case "edgeSave":
                this.spawnBurst(r.x - 10, r.y - 4, AMBER, 9, 320, true);
                this.addPopup(r.x, r.y - 86, "EDGE SAVE", AMBER, 24);
                break;
            case "pickup":
                this.spawnBurst(r.x + 14, r.y - RUNNER_HEIGHT / 2, CYAN, 6, 220, true);
                if (event.chain > 0 && event.chain % 5 === 0) {
                    this.addPopup(r.x, r.y - 96, `CHAIN ×${event.chain}`, CYAN, 26);
                }
                break;
            case "nearMiss":
                this.addPopup(r.x + 30, r.y - 100, "SWOOSH +25", 0xffffff, 28);
                this.spawnBurst(r.x - 16, r.y - 30, 0xffffff, 5, 260, true);
                break;
            case "stumble":
                this.addShake(8);
                this.addFlash(0xff5c7a, 0.3);
                this.spawnShatter(r.x + 20, r.y - 24, 0x9aa5c8, 14);
                this.scarfPoints = [];
                break;
            case "smash":
                this.addShake(event.billboard ? 7 : 4);
                this.spawnShatter(r.x + 26, r.y - 40, event.billboard ? AMBER : 0x9aa5c8, event.billboard ? 22 : 12);
                this.addPopup(r.x + 20, r.y - 110, event.billboard ? "SMASH +40" : "SMASH +15", AMBER, 26);
                break;
            case "powerupStart":
                this.spawnBurst(r.x, r.y - 30, POWERUP_COLORS[event.kind], 16, 380, true);
                this.addPopup(r.x, r.y - 118, POWERUP_LABELS[event.kind], POWERUP_COLORS[event.kind], 30);
                this.zoomPulse = 1;
                break;
            case "powerupSwap":
                this.spawnBurst(r.x, r.y - 30, POWERUP_COLORS[event.to], 16, 380, true);
                this.addPopup(r.x, r.y - 118, `${POWERUP_LABELS[event.to]} · SWAPPED`, POWERUP_COLORS[event.to], 26);
                break;
            case "powerupEnd":
                break;
            case "flowTier":
                this.addPopup(r.x, r.y - 130, `FLOW ×${event.tier}`, MAGENTA, 34);
                this.zoomPulse = 1;
                this.spawnBurst(r.x, r.y - 40, MAGENTA, 12, 300, true);
                break;
            case "speedTier":
                if (event.tier >= 3 && event.tier % 3 === 0) {
                    this.addPopup(r.x, r.y - 118, "FASTER", 0xffffff, 22);
                }
                break;
            case "death":
                this.deathT = 0;
                this.deathCause = event.cause;
                this.addShake(event.cause === "billboard" ? 12 : 8);
                this.addFlash(event.cause === "billboard" ? AMBER : MAGENTA, 0.5);
                if (event.cause === "billboard") this.spawnShatter(r.x + 20, r.y - 40, AMBER, 26);
                this.spawnBurst(r.x, r.y - 30, MAGENTA, 18, 420, false);
                break;
            case "revive":
                this.deathT = -1;
                this.deathCause = null;
                this.scarfPoints = [];
                this.addFlash(GREEN, 0.24);
                this.spawnBurst(r.x, r.y - 30, GREEN, 20, 380, true);
                break;
        }
    }

    private addShake(amount: number): void {
        if (this.reducedMotion) return;
        this.shake = Math.min(16, this.shake + amount);
    }

    private addFlash(color: number, strength: number): void {
        this.flashColor = color;
        this.flash = Math.max(this.flash, strength);
    }

    /* ------------------------------------------------------------- particles */

    private particleBudget(): number {
        return this.reducedMotion ? 60 : 240;
    }

    private pushParticle(particle: Particle): void {
        if (this.particles.length >= this.particleBudget()) this.particles.shift();
        this.particles.push(particle);
    }

    private spawnDust(x: number, y: number, count: number, spread: number): void {
        const total = this.reducedMotion ? Math.ceil(count / 4) : count;
        for (let i = 0; i < total; i += 1) {
            const angle = Math.PI + (i / Math.max(1, total - 1) - 0.5) * 1.6 * spread;
            const speed = 60 + hash01(i * 31 + Math.round(x)) * 120;
            this.pushParticle({
                x: x + jitter(i * 7) * 10,
                y: y - 2,
                vx: Math.cos(angle) * speed,
                vy: -30 - hash01(i * 13) * 70,
                life: 0.4 + hash01(i * 17) * 0.3,
                maxLife: 0.7,
                size: 2.4 + hash01(i * 23) * 3,
                color: 0x8b95b8,
                gravity: -60,
                drag: 2.4,
                shard: false,
                spin: 0,
                angle: 0,
                glow: false,
            });
        }
    }

    private spawnBurst(x: number, y: number, color: number, count: number, speed: number, glow: boolean): void {
        const total = this.reducedMotion ? Math.ceil(count / 4) : count;
        for (let i = 0; i < total; i += 1) {
            const angle = (i / total) * Math.PI * 2 + jitter(i * 11) * 0.4;
            const velocity = speed * (0.4 + hash01(i * 19 + Math.round(x)) * 0.8);
            this.pushParticle({
                x,
                y,
                vx: Math.cos(angle) * velocity,
                vy: Math.sin(angle) * velocity,
                life: 0.35 + hash01(i * 29) * 0.35,
                maxLife: 0.7,
                size: 1.8 + hash01(i * 37) * 2.6,
                color,
                gravity: 260,
                drag: 1.6,
                shard: false,
                spin: 0,
                angle: 0,
                glow,
            });
        }
    }

    private spawnShatter(x: number, y: number, color: number, count: number): void {
        const total = this.reducedMotion ? Math.ceil(count / 4) : count;
        for (let i = 0; i < total; i += 1) {
            const angle = -Math.PI * 0.8 + (i / total) * Math.PI * 1.4;
            const velocity = 160 + hash01(i * 41 + Math.round(y)) * 340;
            this.pushParticle({
                x,
                y,
                vx: Math.cos(angle) * velocity + 120,
                vy: Math.sin(angle) * velocity,
                life: 0.5 + hash01(i * 43) * 0.4,
                maxLife: 0.9,
                size: 3 + hash01(i * 47) * 5,
                color,
                gravity: 1500,
                drag: 0.4,
                shard: true,
                spin: jitter(i * 53) * 12,
                angle: hash01(i * 59) * Math.PI,
                glow: false,
            });
        }
    }

    /* ---------------------------------------------------------------- popups */

    private addPopup(x: number, y: number, label: string, color: number, size: number): void {
        const popupStarted = import.meta.env.DEV ? performance.now() : 0;
        const fresh = this.popupTextPool.length === 0;
        const text =
            this.popupTextPool.pop() ??
            new Text({
                text: label,
                style: new TextStyle({
                    fontFamily: HUD_FONT,
                    fontSize: 30,
                    fontWeight: "700",
                    letterSpacing: 2,
                    fill: 0xffffff,
                }),
            });
        text.text = label;
        text.style.fontSize = size;
        text.style.fill = color;
        text.style.dropShadow = {
            alpha: 0.8,
            angle: Math.PI / 2,
            blur: 6,
            color: 0x05070f,
            distance: 2,
        };
        text.anchor.set(0.5, 1);
        text.alpha = 1;
        this.popupLayer.addChild(text);
        this.popups.push({ text, x, y, life: 0.95, maxLife: 0.95, rise: 34 });
        if (import.meta.env.DEV) {
            const cost = performance.now() - popupStarted;
            const key = fresh ? "popupCreate" : "popupReuse";
            this.phaseMs[key] = (this.phaseMs[key] ?? 0) + cost;
            this.phaseMs[`${key}Max`] = Math.max(this.phaseMs[`${key}Max`] ?? 0, cost);
            this.phaseMs[`${key}N`] = (this.phaseMs[`${key}N`] ?? 0) + 1;
        }
        if (this.popups.length > 10) {
            const oldest = this.popups.shift();
            if (oldest) this.retirePopup(oldest);
        }
    }

    private retirePopup(popup: Popup): void {
        this.popupLayer.removeChild(popup.text);
        this.popupTextPool.push(popup.text);
    }

    /* ------------------------------------------------------------ atmosphere */

    private seedStars(): void {
        this.stars = [];
        const w = this.viewport.designWidth;
        const count = Math.round(w / 22);
        for (let i = 0; i < count; i += 1) {
            this.stars.push({
                x: hash01(i * 71) * w,
                y: hash01(i * 73) * 300,
                size: 0.7 + hash01(i * 79) * 1.4,
                speed: 0.6 + hash01(i * 83) * 2.4,
                warm: hash01(i * 89) < 0.18,
            });
        }
    }

    private seedRain(): void {
        this.rain = [];
        const w = this.viewport.designWidth;
        const count = Math.round((w / 1280) * (this.reducedMotion ? 26 : 104));
        for (let i = 0; i < count; i += 1) {
            this.rain.push({
                x: hash01(i * 91) * (w + 300) - 150,
                y: hash01(i * 97) * STAGE_HEIGHT,
                depth: 0.5 + hash01(i * 101) * 0.9,
            });
        }
    }

    /* ----------------------------------------------------------------- frame */

    render(snapshot: RunnerSnapshot, delta: number): void {
        this.time += delta;
        const speed = snapshot.phase === "dead" ? 0 : snapshot.runner.speed;
        if (this.mode === "menu") this.menuDrift += delta * 26;
        if (this.deathT >= 0) this.deathT += delta;

        // Per-phase timing, development only: a frame drop is unfixable until
        // you know which pass spent the milliseconds.
        const phase = import.meta.env.DEV
            ? (name: string, run: () => void) => {
                  const started = performance.now();
                  run();
                  this.phaseMs[name] = (this.phaseMs[name] ?? 0) + (performance.now() - started);
              }
            : (_name: string, run: () => void) => run();

        this.updateCamera(snapshot, delta);
        phase("sky", () => this.drawSky(delta));
        this.updateParallax();
        phase("world", () => this.drawWorld(snapshot));
        phase("runner", () => this.drawRunner(snapshot, delta));
        phase("particles", () => this.drawParticles(delta));
        phase("rain", () => this.drawRain(delta, speed));
        phase("overlay", () => this.drawOverlay(snapshot, delta));
        phase("popups", () => this.updatePopups(delta));
        this.phaseFrames += 1;
    }

    /** Mean milliseconds per phase since the last read, then resets. */
    drainPhaseTimings(): Record<string, number> {
        const frames = Math.max(1, this.phaseFrames);
        const out: Record<string, number> = { frames: this.phaseFrames };
        for (const [name, total] of Object.entries(this.phaseMs)) {
            out[name] = Number((total / frames).toFixed(3));
        }
        this.phaseMs = {};
        this.phaseFrames = 0;
        return out;
    }

    private updateCamera(snapshot: RunnerSnapshot, delta: number): void {
        this.flash = Math.max(0, this.flash - delta * 3);
        this.zoomPulse = Math.max(0, this.zoomPulse - delta * 2.6);
        this.landSquash = Math.max(0, this.landSquash - delta * 5);
        this.jumpStretch = Math.max(0, this.jumpStretch - delta * 5);

        let targetX = snapshot.camera.x;
        // Death overscroll: the city keeps travelling for a beat without you.
        if (this.deathT >= 0) targetX += Math.min(1, this.deathT * 2.2) * 150;
        this.cameraX = targetX;

        // Soft vertical follow keeps high roofs and deep drops in frame.
        const anchor = snapshot.runner.grounded ? snapshot.runner.y : Math.min(snapshot.runner.y, ROOF_TOP_MAX + 60);
        const targetY = (430 - Math.max(230, Math.min(620, anchor))) * 0.55;
        const follow = Math.min(1, delta * 5);
        this.cameraY += (targetY - this.cameraY) * follow;

        if (this.shake > 0.01) {
            this.shake = Math.max(0, this.shake - delta * 30);
            this.shakeX = jitter(Math.round(this.time * 240)) * this.shake;
            this.shakeY = jitter(Math.round(this.time * 240) + 7) * this.shake;
        } else {
            this.shakeX = 0;
            this.shakeY = 0;
        }

        const pulse = this.reducedMotion ? 1 : 1 + this.zoomPulse * 0.006;
        this.stage.scale.set(this.viewport.scale * pulse);
        this.world.position.set(-this.cameraX + this.shakeX, this.cameraY + this.shakeY);
    }

    private drawSky(delta: number): void {
        const g = this.starGraphics;
        g.clear();
        for (let i = 0; i < this.stars.length; i += 1) {
            const star = this.stars[i];
            if (!star) continue;
            const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(this.time * star.speed + i));
            g.circle(star.x, star.y, star.size).fill({
                color: star.warm ? 0xffd9a0 : 0xcfe4ff,
                alpha: twinkle * 0.5,
            });
        }
        this.moonGlow.alpha = 0.42 + Math.sin(this.time * 0.8) * 0.05;
        this.horizonGlow.alpha = 0.44 + Math.sin(this.time * 0.5) * 0.06;
        // The horizon bloom drifts toward the current district's accent.
        const district = districtAt(this.cameraX + 640);
        const targetTint = mixColor(HORIZON_BLOOM, district.accent, 0.45);
        this.ambienceTint = mixColor(this.ambienceTint, targetTint, Math.min(1, delta * 1.2));
        this.horizonGlow.tint = this.ambienceTint;

        // A distant storm: every so often a fork of lightning back-lights the
        // skyline for a quarter second. Pure backdrop — never over the play.
        if (!this.reducedMotion) {
            if (this.lightningT < 0 && this.time > this.nextLightningAt) {
                this.lightningT = 0;
                this.lightningX = 0.1 + hash01(Math.round(this.time * 31)) * 0.5;
                this.nextLightningAt = this.time + 9 + hash01(Math.round(this.time * 53)) * 13;
            }
            if (this.lightningT >= 0) {
                this.lightningT += delta;
                const t = this.lightningT;
                // Two pulses: strike, dim, re-strike.
                const envelope = t < 0.07 ? 1 : t < 0.12 ? 0.25 : t < 0.2 ? 0.75 : Math.max(0, (0.3 - t) * 4);
                this.lightningFlash = envelope;
                if (t > 0.32) {
                    this.lightningT = -1;
                    this.lightningFlash = 0;
                } else if (envelope > 0.1) {
                    const boltSeed = Math.round(this.nextLightningAt * 97);
                    let bx = this.viewport.designWidth * this.lightningX;
                    let by = 30;
                    g.moveTo(bx, by);
                    for (let seg = 1; seg <= 6; seg += 1) {
                        bx += jitter(boltSeed + seg * 7) * 34;
                        by += 38 + hash01(boltSeed + seg * 13) * 22;
                        g.lineTo(bx, by);
                        if (seg === 3) {
                            // One branch forking off the main channel.
                            g.lineTo(bx + jitter(boltSeed + 71) * 50, by + 46);
                            g.moveTo(bx, by);
                        }
                    }
                    g.stroke({ color: 0xeaf6ff, width: 2, alpha: envelope * 0.85 });
                }
            }
        }
    }

    private updateParallax(): void {
        const drift = this.cameraX + this.menuDrift;
        this.farLayer.tilePosition.x = -drift * 0.12;
        this.midLayer.tilePosition.x = -drift * 0.3;
        this.nearLayer.tilePosition.x = -drift * 0.55;
    }

    /* ------------------------------------------------------------ the city */

    /**
     * The city's masonry — faces, windows, parapets, pipes, rims, streaks and
     * district dressing — does not move relative to the world container and
     * does not animate. Re-tessellating it every frame was the single most
     * expensive thing this renderer did; it now rebuilds only when the set of
     * visible roofs actually changes (roughly once a second at speed).
     */
    private rebuildStaticCity(snapshot: RunnerSnapshot): void {
        const signature = snapshot.world.roofs.map((roof) => `${roof.x0}:${roof.top}`).join("|");
        if (signature === this.citySignature) return;
        this.citySignature = signature;

        const buildings = this.buildingGraphics;
        const rim = this.rimGraphics;
        buildings.clear();
        rim.clear();
        this.flickerWindows = [];
        const bottom = KILL_PLANE + 240;

        for (const roof of snapshot.world.roofs) {
            const width = roof.x1 - roof.x0;
            const district = districtAt(roof.x0);
            const accent = district.accent;
            const second = district.second;
            // The building face, drawn to well below the kill plane.
            buildings.rect(roof.x0, roof.top, width, bottom - roof.top).fill({ color: SKYLINE });
            // Lit windows, deterministic per roof so they do not shimmer.
            const key = Math.round(roof.x0);
            const columns = Math.floor(width / 46);
            const cool = mixColor(FACE_WINDOW_COOL, accent, 0.5);
            for (let c = 0; c < columns; c += 1) {
                for (let row = 0; row < 7; row += 1) {
                    const cellKey = key * 13 + c * 7 + row * 101;
                    const roll = hash01(cellKey);
                    if (roll > district.windowChance) continue;
                    const wx = roof.x0 + 20 + c * 46 + hash01(cellKey + 1) * 10;
                    const wy = roof.top + 46 + row * 64 + hash01(cellKey + 2) * 16;
                    if (wx + 14 > roof.x1 - 8 || wy > bottom - 40) continue;
                    const color = roll < 0.05 ? cool : FACE_WINDOW_WARM;
                    // The rare flickering ones move to the animated layer so
                    // the other ~98% can stay baked.
                    if (roll < 0.02) {
                        this.flickerWindows.push({ x: wx, y: wy, color, key: cellKey });
                        continue;
                    }
                    buildings.rect(wx, wy, 13, 18).fill({ color, alpha: 0.16 });
                }
            }
            // Parapet lip.
            buildings.rect(roof.x0, roof.top, width, 9).fill({ color: 0x0d1230 });
            // Distance ticks along the parapet sell the scroll speed.
            for (let tick = Math.ceil(roof.x0 / 90) * 90; tick < roof.x1; tick += 90) {
                buildings.rect(tick, roof.top + 2, 3, 5).fill({ color: 0x1a2350, alpha: 0.9 });
            }
            // Rooftop furniture (deterministic per roof): stair bulkheads and
            // pipe runs so the play layer has its own texture, distinct from
            // the flat parallax silhouettes behind it.
            if (width > 380) {
                const doorX = roof.x0 + 60 + hash01(key * 5 + 3) * (width - 200);
                buildings.rect(doorX, roof.top - 0.5, 30, 0.5).fill({ color: 0x0d1230 });
                const pipeY = roof.top + 14;
                const pipeStart = roof.x0 + 24 + hash01(key * 5 + 4) * 60;
                const pipeEnd = roof.x1 - 24 - hash01(key * 5 + 5) * 60;
                buildings.rect(pipeStart, pipeY, Math.max(0, pipeEnd - pipeStart), 2.4).fill({
                    color: 0x141c40,
                    alpha: 0.9,
                });
                for (let riser = pipeStart + 40; riser < pipeEnd; riser += 130) {
                    buildings.rect(riser, roof.top + 8, 2.4, 8).fill({ color: 0x141c40, alpha: 0.9 });
                }
            }
            // Rain-slick sheen: broken neon reflections along the parapet.
            const streaks = Math.max(1, Math.floor(width / 200));
            for (let streak = 0; streak < streaks; streak += 1) {
                const streakKey = key * 17 + streak * 29;
                const sx = roof.x0 + 24 + hash01(streakKey) * Math.max(1, width - 130);
                const sw = 36 + hash01(streakKey + 1) * 88;
                rim.rect(sx, roof.top + 6.5, Math.min(sw, roof.x1 - sx - 8), 1.6).fill({
                    color: streak % 3 === 2 ? second : accent,
                    alpha: 0.06 + hash01(streakKey + 2) * 0.08,
                });
            }
            // The neon rim in the district's colour.
            rim.rect(roof.x0, roof.top - 2, width, 3).fill({ color: accent, alpha: 1 });
            rim.rect(roof.x0, roof.top - 2, 3.4, 14).fill({ color: accent, alpha: 0.8 });
            rim.rect(roof.x1 - 3.4, roof.top - 2, 3.4, 14).fill({ color: accent, alpha: 0.8 });
            // A faint edge drop light down each face.
            rim.rect(roof.x0, roof.top, 2.4, Math.min(150, bottom - roof.top)).fill({ color: accent, alpha: 0.2 });
            rim.rect(roof.x1 - 2.4, roof.top, 2.4, Math.min(150, bottom - roof.top)).fill({
                color: accent,
                alpha: 0.2,
            });
            this.drawDistrictProps(roof.x0, roof.x1, roof.top, district.index, accent, second);
        }
    }

    private drawWorld(snapshot: RunnerSnapshot): void {
        const props = this.propGraphics;
        const cells = this.cellGraphics;
        props.clear();
        cells.clear();
        this.glowPool.begin();
        this.barPool.begin();

        this.rebuildStaticCity(snapshot);

        const flowGlow = 0.5 + snapshot.flow.tier * 0.14;

        // The handful of animated windows, over the baked masonry.
        for (const window of this.flickerWindows) {
            const flicker = 0.5 + 0.5 * Math.abs(Math.sin(this.time * 7 + window.key));
            props.rect(window.x, window.y, 13, 18).fill({ color: window.color, alpha: 0.16 * flicker });
        }

        for (const roof of snapshot.world.roofs) {
            // The rim's additive glow tracks flow, so it stays per-frame — but
            // it is a pooled sprite, not geometry, so it costs almost nothing.
            const barSprite = this.barPool.get();
            barSprite.tint = districtAt(roof.x0).accent;
            barSprite.position.set((roof.x0 + roof.x1) / 2, roof.top - 2);
            barSprite.scale.set((roof.x1 - roof.x0) / 256, 0.74);
            barSprite.alpha = 0.62 * flowGlow;

            // Pigeons roost on long roofs and scatter when the runner arrives.
            const width = roof.x1 - roof.x0;
            const key = Math.round(roof.x0);
            if (width > 360 && !this.birdFlocks.has(key) && hash01(key * 41 + 9) < 0.5) {
                const clearOfObstacles = (bx: number): boolean =>
                    !snapshot.world.obstacles.some((entry) => bx > entry.x - 40 && bx < entry.x + entry.w + 40);
                const birdX = roof.x0 + 130 + hash01(key * 41 + 10) * (width - 280);
                if (clearOfObstacles(birdX)) {
                    this.birdFlocks.set(key, {
                        x: birdX,
                        y: roof.top,
                        count: 1 + Math.floor(hash01(key * 41 + 11) * 3),
                        scaredAt: -1,
                    });
                }
            }
        }
        this.drawBirds(snapshot);

        for (const obstacle of snapshot.world.obstacles) {
            if (obstacle.dead) continue;
            const obstacleDistrict = districtAt(obstacle.x);
            this.drawObstacle(
                props,
                obstacle.x,
                obstacle.top,
                obstacle.w,
                obstacle.h,
                obstacle.kind,
                obstacleDistrict.accent,
                obstacleDistrict.second,
            );
        }

        for (const cell of snapshot.world.cells) {
            const bob = Math.sin(this.time * 3.4 + cell.x * 0.02) * 4;
            const y = cell.y + bob;
            const glowSprite = this.glowPool.get();
            glowSprite.tint = CYAN;
            glowSprite.position.set(cell.x, y);
            glowSprite.scale.set(0.34);
            glowSprite.alpha = 0.65;
            cells.poly([cell.x, y - 9, cell.x + 7, y, cell.x, y + 9, cell.x - 7, y]).fill({ color: CYAN });
            cells.poly([cell.x, y - 4.5, cell.x + 3.5, y, cell.x, y + 4.5, cell.x - 3.5, y]).fill({
                color: 0xffffff,
                alpha: 0.9,
            });
        }

        for (const drop of snapshot.world.powerups) {
            this.drawPowerup(props, drop.x, drop.y, drop.kind);
        }
    }

    /**
     * Per-district rooftop dressing, deterministic per roof: sign posts in
     * the signage quarter, chimney stacks in the industrial belt, dishes
     * uptown, planter shrubs on the park grid. Pure set dressing — always
     * drawn between the 140 u edge-clear zones, never near the running line's
     * obstacles' language.
     */
    private drawDistrictProps(
        x0: number,
        x1: number,
        top: number,
        index: number,
        accent: number,
        second: number,
    ): void {
        const width = x1 - x0;
        if (width < 420) return;
        // Dressing draws into the BUILDING layer, dimmer and smaller than any
        // obstacle, so it can never be misread as something to jump.
        const g = this.buildingGraphics;
        const key = Math.round(x0);
        const px = x0 + 170 + hash01(key * 23 + index) * (width - 340);
        if (index === 1) {
            // Vertical neon sign post on the parapet, background-dim.
            const h = 30 + hash01(key * 29) * 16;
            g.rect(px - 1.6, top - h, 3.2, h).fill({ color: 0x1a2350, alpha: 0.7 });
            const segments = 2 + Math.floor(hash01(key * 31) * 3);
            for (let seg = 0; seg < segments; seg += 1) {
                const flick = hash01(key * 37 + seg) < 0.12 ? 0.3 + 0.7 * Math.abs(Math.sin(this.time * 6 + seg)) : 1;
                g.rect(px + 3, top - h + 5 + seg * 10, 6, 7).fill({
                    color: seg % 2 === 0 ? accent : second,
                    alpha: 0.45 * flick,
                });
            }
        } else if (index === 2) {
            // Chimney stacks with a warm sodium lamp.
            const stacks = 1 + Math.floor(hash01(key * 41) * 2);
            for (let stack = 0; stack < stacks; stack += 1) {
                const sx = px + stack * 34;
                const h = 22 + hash01(key * 43 + stack) * 16;
                g.rect(sx, top - h, 14, h).fill({ color: 0x131a38, alpha: 0.8 });
                g.rect(sx - 2, top - h - 3, 18, 4).fill({ color: 0x1e2856, alpha: 0.8 });
            }
            g.circle(px - 12, top - 5, 2.2).fill({ color: AMBER, alpha: 0.3 + 0.2 * Math.sin(this.time * 2 + px) });
        } else if (index === 3) {
            // Satellite dish looking uptown.
            g.rect(px - 2, top - 16, 4, 16).fill({ color: 0x1a2350, alpha: 0.8 });
            g.ellipse(px + 7, top - 22, 11, 8).stroke({ color: 0x33417f, width: 2.2, alpha: 0.8 });
            g.circle(px + 7, top - 22, 2).fill({ color: accent, alpha: 0.5 });
        } else if (index === 4) {
            // Planter box with shrubs — a rooftop garden strip.
            g.rect(px - 20, top - 7, 40, 7).fill({ color: 0x131a38 });
            for (let shrub = 0; shrub < 4; shrub += 1) {
                const bx = px - 14 + shrub * 10;
                g.circle(bx, top - 10, 4.6 + hash01(key * 53 + shrub) * 2).fill({
                    color: mixColor(0x0f3524, GREEN, 0.22),
                });
            }
        }
    }

    /**
     * Roosting pigeons: idle head-bobs until the runner closes in, then the
     * whole flock bursts upward and away with staggered wing-beats.
     */
    private drawBirds(snapshot: RunnerSnapshot): void {
        const g = this.propGraphics;
        const runner = snapshot.runner;
        const cutoff = this.cameraX - 400;
        for (const [key, flock] of this.birdFlocks) {
            if (flock.x < cutoff || (flock.scaredAt >= 0 && this.time - flock.scaredAt > 2.6)) {
                this.birdFlocks.delete(key);
                continue;
            }
            if (
                flock.scaredAt < 0 &&
                snapshot.phase === "running" &&
                Math.abs(flock.x - runner.x) < 200 &&
                Math.abs(flock.y - runner.y) < 160
            ) {
                flock.scaredAt = this.time;
            }
            for (let bird = 0; bird < flock.count; bird += 1) {
                const perchX = flock.x + bird * 12 - (flock.count - 1) * 6;
                if (flock.scaredAt < 0) {
                    // Perched: body, head with an occasional peck.
                    const peck = Math.sin(this.time * 1.7 + bird * 2.3 + flock.x * 0.05) > 0.9 ? 2.2 : 0;
                    const by = flock.y - 4;
                    g.ellipse(perchX, by, 4.4, 3.2).fill({ color: 0x9fb0dd });
                    g.circle(perchX + 3.4, by - 3.4 + peck, 2.1).fill({ color: 0x9fb0dd });
                    g.poly([
                        perchX + 5.2,
                        by - 3.6 + peck,
                        perchX + 7.4,
                        by - 3 + peck,
                        perchX + 5.2,
                        by - 2.4 + peck,
                    ]).fill({
                        color: AMBER,
                        alpha: 0.9,
                    });
                    g.poly([perchX - 3.6, by - 1, perchX - 7, by + 1.4, perchX - 3.6, by + 1.4]).fill({
                        color: 0x8397c9,
                    });
                } else {
                    // Fleeing: staggered take-off, up and forward, wings beating.
                    const t = Math.max(0, this.time - flock.scaredAt - bird * 0.07);
                    if (t <= 0) continue;
                    const fade = Math.max(0, 1 - t / 2.2);
                    if (fade <= 0) continue;
                    const px = perchX + t * (150 + bird * 45) + t * t * 30;
                    const py = flock.y - 8 - t * (150 + bird * 35) + Math.sin(t * 15 + bird) * 5;
                    const flap = Math.sin(t * 26 + bird * 1.7) * 6;
                    g.moveTo(px - 8, py - flap)
                        .lineTo(px, py)
                        .lineTo(px + 8, py - flap)
                        .stroke({ color: 0xb9c8ef, width: 2.2, alpha: fade, cap: "round", join: "round" });
                    g.circle(px, py, 2.6).fill({ color: 0x9fb0dd, alpha: fade });
                }
            }
        }
    }

    private drawObstacle(
        g: Graphics,
        x: number,
        top: number,
        w: number,
        h: number,
        kind: "vent" | "ac" | "antenna" | "billboard",
        accent: number,
        second: number,
    ): void {
        const base = top + h;
        // Every obstacle is anchored by a contact shadow and reads like the
        // roofs do: a lit top rim over a solid body, never a black-on-black box.
        g.ellipse(x + w / 2, base + 1.5, w * 0.62 + 4, 3).fill({ color: 0x000208, alpha: 0.55 });
        if (kind === "billboard") {
            // Lethal, and dressed like it: amber hazard stripes on dark steel.
            const legInset = w * 0.18;
            g.rect(x + legInset, base - h * 0.35, 5, h * 0.35).fill({ color: 0x1a2350 });
            g.rect(x + w - legInset - 5, base - h * 0.35, 5, h * 0.35).fill({ color: 0x1a2350 });
            const panelH = h * 0.72;
            g.rect(x - 6, top, w + 12, panelH).fill({ color: 0x10162e });
            g.rect(x - 6, top, w + 12, panelH).stroke({ color: AMBER, width: 3, alpha: 1 });
            // The ad panel: flickering neon bars.
            const flicker = 0.65 + 0.35 * Math.abs(Math.sin(this.time * 9 + x * 0.05));
            g.rect(x + 4, top + 10, w - 8, 8).fill({ color: second, alpha: 0.85 * flicker });
            g.rect(x + 4, top + 24, w * 0.6, 6).fill({ color: accent, alpha: 0.7 * flicker });
            g.rect(x + 4, top + 36, w * 0.42, 6).fill({ color: accent, alpha: 0.5 });
            // Hazard chevrons across the base of the panel.
            const stripeTop = top + panelH - 14;
            for (let sx = x - 6; sx < x + w + 6; sx += 16) {
                g.poly([sx, stripeTop + 14, sx + 8, stripeTop, sx + 16, stripeTop + 14]).fill({
                    color: AMBER,
                    alpha: 0.95,
                });
            }
            const glowSprite = this.glowPool.get();
            glowSprite.tint = AMBER;
            glowSprite.position.set(x + w / 2, top + panelH / 2);
            glowSprite.scale.set(w / 60, panelH / 95);
            glowSprite.alpha = 0.42 * flicker;
            return;
        }
        if (kind === "vent") {
            g.rect(x, top + 2, w, h - 2).fill({ color: 0x1a2350 });
            for (let slat = top + 9; slat < base - 4; slat += 7) {
                g.rect(x + 3, slat, w - 6, 2.6).fill({ color: 0x2f3c78 });
            }
            // Warm exhaust light breathing between the slats.
            const breathe = 0.5 + 0.5 * Math.sin(this.time * 2.2 + x * 0.11);
            g.rect(x + 3, top + 8, w - 6, h - 14).fill({ color: AMBER, alpha: 0.1 + 0.1 * breathe });
            // Lit cap, rimmed like the roofs.
            g.rect(x - 3, top - 3, w + 6, 6).fill({ color: 0x2a3672 });
            g.rect(x - 3, top - 4.4, w + 6, 2).fill({ color: accent, alpha: 0.85 });
            const glowSprite = this.glowPool.get();
            glowSprite.tint = accent;
            glowSprite.position.set(x + w / 2, top - 3);
            glowSprite.scale.set(w / 110, 0.22);
            glowSprite.alpha = 0.5;
            return;
        }
        if (kind === "ac") {
            g.rect(x, top + 2, w, h - 2).fill({ color: 0x1a2350 });
            g.rect(x, top + 2, w, h - 2).stroke({ color: 0x33417f, width: 2 });
            const fanX = x + w * 0.5;
            const fanY = top + h * 0.48;
            const radius = Math.min(w, h) * 0.3;
            g.circle(fanX, fanY, radius + 2).fill({ color: 0x0e1430 });
            g.circle(fanX, fanY, radius).stroke({ color: 0x4a5aa8, width: 2.6 });
            const spin = this.time * 10;
            for (let blade = 0; blade < 3; blade += 1) {
                const angle = spin + (blade * Math.PI * 2) / 3;
                g.moveTo(fanX, fanY);
                g.lineTo(fanX + Math.cos(angle) * radius * 0.85, fanY + Math.sin(angle) * radius * 0.85);
            }
            g.stroke({ color: 0x4a5aa8, width: 2.4 });
            // Grill slits beside the fan.
            for (let slit = top + 8; slit < base - 6; slit += 8) {
                g.rect(x + 4, slit, w * 0.16, 2).fill({ color: 0x33417f });
            }
            const led = 0.5 + 0.5 * Math.sin(this.time * 4 + x);
            g.circle(x + w - 6, top + 8, 2.2).fill({ color: GREEN, alpha: 0.5 + 0.5 * led });
            // Lit top rim.
            g.rect(x - 2, top, w + 4, 3).fill({ color: 0x2a3672 });
            g.rect(x - 2, top - 1.6, w + 4, 1.8).fill({ color: accent, alpha: 0.8 });
            const glowSprite = this.glowPool.get();
            glowSprite.tint = accent;
            glowSprite.position.set(x + w / 2, top);
            glowSprite.scale.set(w / 110, 0.22);
            glowSprite.alpha = 0.45;
            return;
        }
        // Antenna: a guyed mast with dish and a blinking aircraft beacon.
        g.rect(x + w / 2 - 2.2, top, 4.4, h).fill({ color: 0x2a3672 });
        g.rect(x + w / 2 - 1, top, 2, h).fill({ color: 0x4a5aa8, alpha: 0.8 });
        g.moveTo(x + w / 2, top + h * 0.3);
        g.lineTo(x + w / 2 - 14, base);
        g.moveTo(x + w / 2, top + h * 0.42);
        g.lineTo(x + w / 2 + 14, base);
        g.stroke({ color: 0x33417f, width: 1.8 });
        g.circle(x + w / 2 + 4, top + h * 0.35, 4).stroke({ color: 0x4a5aa8, width: 2 });
        const blink = 0.3 + 0.7 * Math.max(0, Math.sin(this.time * 5 + x));
        g.circle(x + w / 2, top - 4, 3.2).fill({ color: 0xff5c7a, alpha: blink });
        const beaconGlow = this.glowPool.get();
        beaconGlow.tint = 0xff5c7a;
        beaconGlow.position.set(x + w / 2, top - 4);
        beaconGlow.scale.set(0.34);
        beaconGlow.alpha = blink * 0.85;
    }

    private drawPowerup(g: Graphics, x: number, y: number, kind: PowerupKind): void {
        const color = POWERUP_COLORS[kind];
        const bob = Math.sin(this.time * 2.6 + x * 0.03) * 5;
        const cy = y + bob;
        // Pedestal on the roof below.
        g.rect(x - 14, y + 34, 28, 18).fill({ color: 0x0c1126 });
        g.rect(x - 18, y + 50, 36, 4).fill({ color: 0x131a38 });
        g.rect(x - 10, y + 36, 20, 2.4).fill({ color, alpha: 0.8 });
        const glowSprite = this.glowPool.get();
        glowSprite.tint = color;
        glowSprite.position.set(x, cy);
        glowSprite.scale.set(0.8 + Math.sin(this.time * 3 + x) * 0.08);
        glowSprite.alpha = 0.85;
        g.circle(x, cy, 17).stroke({ color, width: 2.6, alpha: 0.95 });
        g.circle(x, cy, 21).stroke({ color, width: 1.2, alpha: 0.35 });
        this.drawPowerupGlyph(g, x, cy, kind, color);
    }

    private drawPowerupGlyph(g: Graphics, x: number, y: number, kind: PowerupKind, color: number): void {
        if (kind === "overdrive") {
            g.poly([x + 3, y - 10, x - 6, y + 2, x - 1, y + 2, x - 3, y + 10, x + 6, y - 2, x + 1, y - 2]).fill({
                color,
            });
        } else if (kind === "magnet") {
            g.moveTo(x - 6, y - 8).lineTo(x - 6, y + 2);
            g.arc(x, y + 2, 6, Math.PI, 0, true);
            g.lineTo(x + 6, y - 8);
            g.stroke({ color, width: 3.4, cap: "round" });
            g.rect(x - 8, y - 9, 4.6, 3.4).fill({ color: 0xffffff, alpha: 0.9 });
            g.rect(x + 3.4, y - 9, 4.6, 3.4).fill({ color: 0xffffff, alpha: 0.9 });
        } else if (kind === "focus") {
            g.circle(x, y, 7).stroke({ color, width: 2.4 });
            g.moveTo(x, y - 4)
                .lineTo(x, y)
                .lineTo(x + 4, y + 2);
            g.stroke({ color, width: 2.2, cap: "round" });
        } else if (kind === "rush") {
            g.poly([x - 8, y - 8, x - 2, y, x - 8, y + 8, x - 5, y + 8, x + 1, y, x - 5, y - 8]).fill({ color });
            g.poly([x, y - 8, x + 6, y, x, y + 8, x + 3, y + 8, x + 9, y, x + 3, y - 8]).fill({ color });
        } else {
            g.poly([x - 6, y + 8, x - 2, y - 8, x + 2, y - 8, x + 6, y + 8, x + 2, y + 5, x - 2, y + 5]).fill({
                color,
            });
            g.circle(x, y + 10.6, 2.4).fill({ color: 0xffffff, alpha: 0.9 });
        }
    }

    /* ------------------------------------------------------------ the runner */

    private drawRunner(snapshot: RunnerSnapshot, delta: number): void {
        const g = this.runnerGraphics;
        const ghosts = this.ghostGraphics;
        const aura = this.auraGraphics;
        const scarf = this.scarfGraphics;
        g.clear();
        ghosts.clear();
        aura.clear();
        scarf.clear();

        const r = snapshot.runner;
        const alive = snapshot.phase !== "dead";
        const speedRatio = Math.min(1, r.speed / 920);
        // The leg cycle is driven by DISTANCE, not a timer: one full stride
        // every ~44 world units keeps the feet honest against the ground at
        // any speed instead of the slow-motion paddle a fixed rate gives.
        if (r.grounded && snapshot.phase === "running") {
            this.runPhase += Math.min(30, (r.speed / 22) * snapshot.timeScale) * delta;
        } else {
            this.runPhase += delta * 4 * snapshot.timeScale;
        }
        // Each footfall on a rain-slick roof kicks up a little spray.
        const step = Math.floor(this.runPhase / Math.PI);
        if (step !== this.runStep) {
            this.runStep = step;
            if (r.grounded && alive && r.speed > 120 && !this.reducedMotion && this.mode === "run") {
                for (let drop = 0; drop < 3; drop += 1) {
                    this.pushParticle({
                        x: r.x - 4 + jitter(step * 7 + drop) * 5,
                        y: r.y - 1,
                        vx: -r.speed * 0.1 - hash01(step * 11 + drop) * 50,
                        vy: -30 - hash01(step * 13 + drop) * 60,
                        life: 0.22 + hash01(step * 17 + drop) * 0.14,
                        maxLife: 0.36,
                        size: 1.3 + hash01(step * 19 + drop) * 1.4,
                        color: 0x9fd8ff,
                        gravity: 900,
                        drag: 1,
                        shard: false,
                        spin: 0,
                        angle: 0,
                        glow: false,
                    });
                }
            }
        }

        // Scarf history: points trail the neck and sag with a little gravity.
        const neckX = r.x - 6;
        const neckY = r.y - RUNNER_HEIGHT + 14;
        this.scarfPoints.unshift({ x: neckX, y: neckY });
        if (this.scarfPoints.length > 15) this.scarfPoints.pop();
        for (let i = 1; i < this.scarfPoints.length; i += 1) {
            const point = this.scarfPoints[i];
            if (!point) continue;
            point.y += delta * 26;
            point.x -= delta * 8;
            point.y += Math.sin(this.time * 9 + i * 0.9) * delta * 40 * (0.4 + speedRatio);
        }

        // Afterimages at speed: ghost silhouettes sampled every few frames.
        this.poseTimer += delta;
        if (this.poseTimer > 0.045) {
            this.poseTimer = 0;
            this.poseHistory.unshift({ x: r.x, y: r.y, phase: this.runPhase, grounded: r.grounded, vy: r.vy });
            if (this.poseHistory.length > 4) this.poseHistory.pop();
        }
        const rushing = snapshot.power?.kind === "rush";
        if (!this.reducedMotion && alive && (speedRatio > 0.5 || rushing)) {
            const strength = rushing ? 1 : (speedRatio - 0.5) * 2;
            for (let i = 1; i < this.poseHistory.length; i += 1) {
                const pose = this.poseHistory[i];
                if (!pose) continue;
                this.paintRunner(ghosts, pose.x, pose.y, pose.phase, pose.grounded, pose.vy, {
                    color: rushing ? MAGENTA : CYAN,
                    alpha: (0.26 - i * 0.06) * strength,
                    scaleX: 1,
                    scaleY: 1,
                    rotation: 0,
                    stride: 0.8 + speedRatio * 0.5,
                });
            }
        }

        // Scarf ribbon — magenta, drawn as tapering segments, over a soft glow.
        if (this.scarfPoints.length > 2) {
            const first = this.scarfPoints[0];
            if (first) {
                for (let i = 0; i < this.scarfPoints.length - 1; i += 1) {
                    const a = this.scarfPoints[i];
                    const b = this.scarfPoints[i + 1];
                    if (!a || !b) continue;
                    const t = i / (this.scarfPoints.length - 1);
                    scarf.moveTo(a.x, a.y);
                    scarf.lineTo(b.x, b.y);
                    scarf.stroke({
                        color: this.ionTrail ? 0xf4f8ff : MAGENTA,
                        width: Math.max(1, 6.5 * (1 - t)),
                        alpha: 0.9 * (1 - t * 0.75),
                        cap: "round",
                    });
                }
            }
        }

        if (!alive && this.deathCause === "fall" && r.y > KILL_PLANE + 120) {
            // Long gone below the frame; the scarf and camera tell the story.
            return;
        }

        const squash = 1 - this.landSquash * 0.2;
        const stretch = 1 + this.jumpStretch * 0.1;
        const tumble = !alive ? Math.min(2.4, (this.deathT < 0 ? 0 : this.deathT) * 6) : 0;
        this.paintRunner(g, r.x, r.y, this.runPhase, r.grounded, r.vy, {
            color: RUNNER_BODY,
            alpha: 1,
            scaleX: 1 / Math.max(0.85, squash * 0.9 + 0.1),
            scaleY: squash * stretch,
            rotation: tumble,
            stride: 0.8 + speedRatio * 0.5,
        });

        // Invulnerability shimmer.
        if (alive && r.invulnerable > 0) {
            const ring = 26 + Math.sin(this.time * 14) * 3;
            aura.circle(r.x, r.y - RUNNER_HEIGHT / 2, ring).stroke({
                color: 0xffffff,
                width: 1.8,
                alpha: 0.28 + 0.2 * Math.sin(this.time * 18),
            });
        }

        // Powerup auras live on the body so state is readable mid-parkour.
        this.glowRunnerAura(snapshot, aura, r.x, r.y);
    }

    private glowRunnerAura(snapshot: RunnerSnapshot, aura: Graphics, x: number, y: number): void {
        const centreY = y - RUNNER_HEIGHT / 2;
        const power = snapshot.power;
        if (power) {
            const color = POWERUP_COLORS[power.kind];
            const ending = power.remaining < 0.5 ? Math.abs(Math.sin(this.time * 22)) : 1;
            const glowSprite = this.glowPool.get();
            glowSprite.tint = color;
            glowSprite.position.set(x, centreY);
            glowSprite.scale.set(0.9 + Math.sin(this.time * 6) * 0.06);
            glowSprite.alpha = 0.4 * ending;
            if (power.kind === "magnet") {
                const radius = 190 * (1 + Math.sin(this.time * 2) * 0.02);
                aura.circle(x, centreY, radius).stroke({ color, width: 1.4, alpha: 0.14 * ending });
                aura.circle(x, centreY, radius * 0.7).stroke({ color, width: 1, alpha: 0.08 * ending });
            }
            if (power.kind === "focus") {
                const ripple = (this.time % 1.1) / 1.1;
                aura.circle(x, centreY, 30 + ripple * 160).stroke({
                    color,
                    width: 2,
                    alpha: (1 - ripple) * 0.3 * ending,
                });
            }
        }
        const mobility = snapshot.mobility;
        if (mobility?.kind === "jets") {
            const ending = mobility.remaining < 0.5 ? Math.abs(Math.sin(this.time * 22)) : 1;
            if (!snapshot.runner.grounded) {
                const flame = 10 + Math.sin(this.time * 30) * 3;
                aura.poly([x - 8, y + 2, x - 3, y + 2 + flame, x + 1, y + 2]).fill({
                    color: GREEN,
                    alpha: 0.8 * ending,
                });
                aura.poly([x + 2, y + 2, x + 6, y + 2 + flame * 0.7, x + 9, y + 2]).fill({
                    color: GREEN,
                    alpha: 0.6 * ending,
                });
            } else {
                aura.circle(x - 6, y - 3, 3).fill({ color: GREEN, alpha: 0.7 * ending });
                aura.circle(x + 6, y - 3, 3).fill({ color: GREEN, alpha: 0.7 * ending });
            }
        }
    }

    /**
     * The figure itself: a pale silhouette built from strokes. Feet sit at
     * (x, y); poses come from speed, phase, and vertical velocity.
     */
    private paintRunner(
        g: Graphics,
        x: number,
        y: number,
        phase: number,
        grounded: boolean,
        vy: number,
        style: {
            color: number;
            alpha: number;
            scaleX: number;
            scaleY: number;
            rotation: number;
            stride?: number;
        },
    ): void {
        const { color, alpha } = style;
        const stride = style.stride ?? 1;
        const h = RUNNER_HEIGHT * style.scaleY;
        const w = RUNNER_WIDTH * style.scaleX;
        // Hips ride the stride: highest mid-flight between footfalls.
        const hipBob = grounded && this.mode === "run" ? Math.abs(Math.sin(phase)) * h * 0.045 : 0;
        const hipY = y - h * 0.42 - hipBob;
        const shoulderY = y - h * 0.78 - hipBob * 0.7;
        const headY = y - h * 0.9 - hipBob * 0.6;
        // Standing still (the menu): a relaxed idle, not a frozen stride.
        const idle = grounded && this.mode === "menu";
        const lean = idle ? 0.05 : grounded ? 0.3 + stride * 0.14 : vy < 0 ? 0.12 : 0.32;
        const leanX = Math.sin(lean) * h * 0.2;
        const rot = style.rotation;
        const cx = x;
        const cy = y - h / 2;
        const rotate = (px: number, py: number): [number, number] => {
            if (rot === 0) return [px, py];
            const dx = px - cx;
            const dy = py - cy;
            return [cx + dx * Math.cos(rot) - dy * Math.sin(rot), cy + dx * Math.sin(rot) + dy * Math.cos(rot)];
        };

        const limb = (
            x1: number,
            y1: number,
            x2: number,
            y2: number,
            x3: number,
            y3: number,
            width: number,
            depth = 1,
        ): void => {
            const [ax, ay] = rotate(x1, y1);
            const [bx, by] = rotate(x2, y2);
            const [ex, ey] = rotate(x3, y3);
            g.moveTo(ax, ay)
                .lineTo(bx, by)
                .lineTo(ex, ey)
                .stroke({ color, width, alpha: alpha * depth, cap: "round", join: "round" });
        };

        // Legs.
        const legW = w * 0.26;
        if (idle) {
            const breathe = Math.sin(this.time * 1.8) * 1.2;
            limb(x, hipY, x - w * 0.14, y - h * 0.2, x - w * 0.2, y, legW);
            limb(x, hipY, x + w * 0.18, y - h * 0.2, x + w * 0.26, y, legW);
            {
                const [ax, ay] = rotate(x, hipY);
                const [bx, by] = rotate(x + leanX, shoulderY + breathe * 0.4);
                g.moveTo(ax, ay)
                    .lineTo(bx, by)
                    .stroke({ color, width: w * 0.42, alpha, cap: "round" });
            }
            const armW = w * 0.22;
            limb(x + leanX, shoulderY + 2, x - w * 0.34, hipY - h * 0.04, x - w * 0.3, hipY + h * 0.12, armW);
            limb(x + leanX, shoulderY + 2, x + w * 0.38, hipY - h * 0.02, x + w * 0.34, hipY + h * 0.14, armW);
            const [hx, hy] = rotate(x + leanX, headY + breathe * 0.6);
            g.circle(hx, hy, w * 0.34).fill({ color, alpha });
            return;
        }
        if (grounded) {
            // Sprint cycle: cos(ph) sweeps each foot front-to-back through
            // stance, then it swings forward HIGH — knees drive, heels kick.
            const reach = h * 0.36 * stride;
            const hipX = x + leanX * 0.3;
            for (const [index, legPhase] of [phase, phase + Math.PI].entries()) {
                const swing = -Math.sin(legPhase); // >0 while the foot returns
                const along = Math.cos(legPhase);
                const footX = x + along * reach + Math.max(0, swing) * w * 0.3;
                const lift = Math.max(0, swing);
                const footY = y - lift * lift * h * 0.3;
                // The knee bends hard on the swing leg, stays long in stance.
                const bend = w * (0.24 + lift * 0.85);
                const kneeX = (hipX + footX) / 2 + bend;
                const kneeY = (hipY + footY) / 2 - lift * h * 0.1;
                // The far leg reads dimmer: instant depth for a one-colour figure.
                limb(hipX, hipY, kneeX, kneeY, footX, footY, legW, index === 0 ? 0.55 : 1);
            }
        } else if (vy < 0) {
            // Rising: front knee tucked high, back leg trailing.
            limb(x + leanX * 0.3, hipY, x + w * 0.5, hipY - h * 0.08, x + w * 0.62, hipY + h * 0.16, legW);
            limb(x + leanX * 0.3, hipY, x - w * 0.3, y - h * 0.18, x - w * 0.72, y - h * 0.04, legW, 0.55);
        } else {
            // Falling: legs reaching for the landing.
            limb(x + leanX * 0.3, hipY, x + w * 0.44, y - h * 0.22, x + w * 0.68, y - h * 0.05, legW);
            limb(x + leanX * 0.3, hipY, x - w * 0.1, y - h * 0.2, x - w * 0.3, y - h * 0.02, legW, 0.55);
        }

        // Torso.
        {
            const [ax, ay] = rotate(x + leanX * 0.2, hipY);
            const [bx, by] = rotate(x + leanX, shoulderY);
            g.moveTo(ax, ay)
                .lineTo(bx, by)
                .stroke({ color, width: w * 0.42, alpha, cap: "round" });
        }

        // Arms pump opposite the legs; in the air they sweep for balance.
        const armW = w * 0.22;
        if (grounded) {
            // Arms pump opposite the legs, elbows locked near ninety degrees.
            const shoulderX = x + leanX;
            for (const [index, armPhase] of [phase + Math.PI, phase].entries()) {
                const pump = Math.cos(armPhase) * stride;
                const elbowX = shoulderX + pump * w * 0.34 - w * 0.06;
                const elbowY = shoulderY + h * 0.17;
                const handX = shoulderX + pump * w * 0.95 + w * 0.12;
                const handY = shoulderY + h * 0.1 - Math.max(0, pump) * h * 0.12;
                limb(shoulderX, shoulderY + 2, elbowX, elbowY, handX, handY, armW, index === 0 ? 0.55 : 1);
            }
        } else if (vy < 0) {
            limb(
                x + leanX,
                shoulderY + 2,
                x + leanX - w * 0.5,
                shoulderY + h * 0.1,
                x + leanX - w * 0.9,
                shoulderY + h * 0.02,
                armW,
            );
            limb(
                x + leanX,
                shoulderY + 2,
                x + leanX + w * 0.55,
                shoulderY - h * 0.02,
                x + leanX + w * 0.9,
                shoulderY - h * 0.1,
                armW,
            );
        } else {
            limb(
                x + leanX,
                shoulderY + 2,
                x + leanX - w * 0.6,
                shoulderY - h * 0.04,
                x + leanX - w * 1,
                shoulderY - h * 0.12,
                armW,
            );
            limb(
                x + leanX,
                shoulderY + 2,
                x + leanX + w * 0.6,
                shoulderY - h * 0.06,
                x + leanX + w * 1,
                shoulderY - h * 0.14,
                armW,
            );
        }

        // Head.
        {
            const [hx, hy] = rotate(x + leanX * 1.2, headY);
            g.circle(hx, hy, w * 0.34).fill({ color, alpha });
        }
    }

    /* ------------------------------------------------------------- particles */

    private drawParticles(delta: number): void {
        const g = this.particleGraphics;
        g.clear();
        // Landing shockwaves: a flat ring racing outward along the roof.
        for (let i = this.rings.length - 1; i >= 0; i -= 1) {
            const ring = this.rings[i];
            if (!ring) continue;
            ring.t += delta;
            const life = 0.4;
            if (ring.t >= life) {
                this.rings.splice(i, 1);
                continue;
            }
            const progress = ring.t / life;
            const radius = 8 + progress * (70 + ring.strength * 80);
            const fade = (1 - progress) * (0.35 + ring.strength * 0.3);
            g.ellipse(ring.x, ring.y - 1, radius, radius * 0.2).stroke({
                color: 0xbfefff,
                width: 2.2 * (1 - progress) + 0.6,
                alpha: fade,
            });
        }
        for (let i = this.particles.length - 1; i >= 0; i -= 1) {
            const p = this.particles[i];
            if (!p) continue;
            p.life -= delta;
            if (p.life <= 0) {
                this.particles.splice(i, 1);
                continue;
            }
            p.vy += p.gravity * delta;
            p.vx *= 1 - Math.min(1, p.drag * delta);
            p.vy *= 1 - Math.min(1, p.drag * delta);
            p.x += p.vx * delta;
            p.y += p.vy * delta;
            p.angle += p.spin * delta;
            const fade = Math.min(1, p.life / (p.maxLife * 0.5));
            if (p.shard) {
                const c = Math.cos(p.angle) * p.size;
                const s = Math.sin(p.angle) * p.size;
                g.poly([p.x + c, p.y + s, p.x - s * 0.5, p.y + c * 0.5, p.x - c, p.y - s]).fill({
                    color: p.color,
                    alpha: fade * 0.9,
                });
            } else {
                g.circle(p.x, p.y, p.size * (p.glow ? fade : 1)).fill({ color: p.color, alpha: fade * 0.9 });
                if (p.glow) {
                    const glowSprite = this.glowPool.get();
                    glowSprite.tint = p.color;
                    glowSprite.position.set(p.x, p.y);
                    glowSprite.scale.set(0.16 * p.size * fade);
                    glowSprite.alpha = fade * 0.5;
                }
            }
        }
        this.glowPool.end();
        this.barPool.end();
    }

    /* ------------------------------------------------------------------ rain */

    private drawRain(delta: number, speed: number): void {
        const g = this.rainGraphics;
        g.clear();
        const buckets = this.rainBuckets;
        const w = this.viewport.designWidth;
        const windX = -(speed * 0.4 + 60);
        for (const drop of this.rain) {
            drop.y += (700 + speed * 0.25) * drop.depth * delta;
            drop.x += windX * drop.depth * delta;
            if (drop.y > STAGE_HEIGHT + 20) {
                drop.y = -30 - hash01(Math.round(drop.x * 7)) * 60;
                drop.x = hash01(Math.round(drop.y * 13) + Math.round(this.time * 997)) * (w + 300) - 100;
            }
            if (drop.x < -160) drop.x += w + 300;
            const lengthX = windX * drop.depth * 0.05;
            const lengthY = (700 + speed * 0.25) * drop.depth * 0.05;
            // Bucket by depth so the whole shower is a handful of stroke calls
            // instead of one per drop — same look, a fraction of the geometry.
            const bucket = Math.min(
                RAIN_DEPTH_BUCKETS - 1,
                Math.floor(((drop.depth - 0.5) / 0.9) * RAIN_DEPTH_BUCKETS),
            );
            const bucketPath = buckets[bucket];
            if (bucketPath) {
                bucketPath.push(drop.x, drop.y, drop.x + lengthX, drop.y + lengthY);
            }
        }
        for (const [index, path] of buckets.entries()) {
            if (path.length === 0) continue;
            for (let i = 0; i < path.length; i += 4) {
                g.moveTo(path[i] ?? 0, path[i + 1] ?? 0).lineTo(path[i + 2] ?? 0, path[i + 3] ?? 0);
            }
            const depth = 0.5 + ((index + 0.5) / RAIN_DEPTH_BUCKETS) * 0.9;
            g.stroke({ color: RAIN, width: depth, alpha: 0.05 + depth * 0.08 });
            path.length = 0;
        }
    }

    /* --------------------------------------------------------------- overlay */

    private drawOverlay(snapshot: RunnerSnapshot, delta: number): void {
        void delta;
        const w = this.viewport.designWidth;

        // FOCUS: violet breathing vignette.
        const focusTarget = snapshot.power?.kind === "focus" ? 0.16 + Math.sin(this.time * 3) * 0.04 : 0;
        this.focusVignette.alpha += (focusTarget - this.focusVignette.alpha) * 0.12;
        // An invisible sprite still blends a full viewport of pixels on the
        // GPU. Take it out of the display list until FOCUS actually needs it.
        this.focusVignette.visible = this.focusVignette.alpha > 0.004;

        // RUSH: magenta speed lines racing past the screen edges.
        const lines = this.speedLineGraphics;
        lines.clear();
        const rushing = snapshot.power?.kind === "rush";
        const fast = snapshot.runner.speed > 640 && snapshot.phase === "running";
        if ((rushing || fast) && !this.reducedMotion) {
            const count = rushing ? 14 : 8;
            const color = rushing ? MAGENTA : 0xffffff;
            for (let i = 0; i < count; i += 1) {
                const laneY = hash01(i * 131) * STAGE_HEIGHT;
                const edgeBias = Math.abs(laneY / STAGE_HEIGHT - 0.5) * 2;
                if (edgeBias < 0.4) continue;
                const speedLine = 900 + hash01(i * 137) * 900;
                const lineX = w - (((this.time * speedLine + hash01(i * 139) * w) % (w + 300)) - 150);
                const length = 60 + hash01(i * 149) * 120;
                lines.moveTo(lineX, laneY).lineTo(lineX + length, laneY);
                lines.stroke({ color, width: 1.6, alpha: 0.12 * edgeBias * (rushing ? 1.6 : 1) });
            }
        }

        const flash = this.flashGraphics;
        flash.clear();
        if (this.lightningFlash > 0.02) {
            // The storm's wash brightens the top of the frame only.
            flash.rect(0, 0, w, 340).fill({ color: 0xcfe4ff, alpha: this.lightningFlash * 0.06 });
        }
        if (this.flash > 0.01) {
            flash.rect(0, 0, w, STAGE_HEIGHT).fill({ color: this.flashColor, alpha: Math.min(0.42, this.flash * 0.5) });
        }
    }

    private updatePopups(delta: number): void {
        for (let i = this.popups.length - 1; i >= 0; i -= 1) {
            const popup = this.popups[i];
            if (!popup) continue;
            popup.life -= delta;
            if (popup.life <= 0) {
                this.popups.splice(i, 1);
                this.retirePopup(popup);
                continue;
            }
            const progress = 1 - popup.life / popup.maxLife;
            popup.text.position.set(popup.x, popup.y - progress * popup.rise);
            popup.text.alpha = 1 - progress * progress;
            popup.text.scale.set(1 + Math.min(0.14, (1 - progress) * 0.04));
        }
    }

    /** Draws a single still frame with no live snapshot, used by the menu. */
    idleFrame(): void {
        this.app.render();
    }

    getPerformanceDiagnostics(): {
        particles: number;
        rainDrops: number;
        popups: number;
        cameraShake: number;
        scale: number;
    } {
        return {
            particles: this.particles.length,
            rainDrops: this.rain.length,
            popups: this.popups.length,
            cameraShake: this.shake,
            scale: this.viewport.scale,
        };
    }

    destroy(): void {
        this.resizeObserver?.disconnect();
        window.cancelAnimationFrame(this.resizeFrame);
        this.app.destroy({ removeView: true }, { children: true });
    }
}
