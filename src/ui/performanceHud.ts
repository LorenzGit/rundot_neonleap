export interface PerformanceFrame {
    frameMs: number;
    simulationMs: number;
    renderMs: number;
    hudMs: number;
}

export interface PerformanceSnapshot {
    enabled: boolean;
    fps: number;
    averageFrameMs: number;
    p95FrameMs: number;
    averageSimulationMs: number;
    averageRenderMs: number;
    averageHudMs: number;
    renderer: string;
    rendererReason: string;
}

function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Missing #${id}`);
    return value as T;
}

function average(values: readonly number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], ratio: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

export class PerformanceHud {
    private readonly root = element<HTMLButtonElement>("performance-hud");
    private readonly fpsElement = element<HTMLElement>("performance-fps");
    private readonly frameElement = element<HTMLElement>("performance-frame");
    private readonly detailElement = element<HTMLElement>("performance-detail");
    private readonly rendererReasonElement = element<HTMLElement>("performance-renderer-reason");
    private readonly frames: PerformanceFrame[] = [];
    private enabled = false;
    private lastUpdateAt = 0;
    private latest: PerformanceSnapshot = {
        enabled: false,
        fps: 0,
        averageFrameMs: 0,
        p95FrameMs: 0,
        averageSimulationMs: 0,
        averageRenderMs: 0,
        averageHudMs: 0,
        renderer: "UNKNOWN",
        rendererReason: "CHECKING GPU PATH",
    };

    isEnabled(): boolean {
        return this.enabled;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        this.frames.length = 0;
        this.lastUpdateAt = performance.now();
        this.latest = { ...this.latest, enabled };
        this.root.classList.toggle("hidden", !enabled);
        this.root.classList.remove("warning", "critical");
        if (enabled) {
            this.fpsElement.textContent = "MEASURING FPS";
            this.frameElement.textContent = "COLLECTING FRAME DATA";
            this.detailElement.textContent = `${document.documentElement.dataset.renderer?.toUpperCase() ?? "UNKNOWN"} · TAP TO HIDE`;
            this.rendererReasonElement.textContent =
                document.documentElement.dataset.rendererReason ?? "CHECKING GPU PATH";
        }
    }

    recordFrame(frame: Readonly<PerformanceFrame>): void {
        if (!this.enabled) return;
        if (Number.isFinite(frame.frameMs) && frame.frameMs > 0 && frame.frameMs < 1000) {
            this.frames.push(frame);
        }
        const now = performance.now();
        if (now - this.lastUpdateAt < 500 || this.frames.length < 3) return;

        const frameTimes = this.frames.map((sample) => sample.frameMs);
        const simulationTimes = this.frames.map((sample) => sample.simulationMs);
        const renderTimes = this.frames.map((sample) => sample.renderMs);
        const hudTimes = this.frames.map((sample) => sample.hudMs);
        const averageFrameMs = average(frameTimes);
        const fps = averageFrameMs > 0 ? 1000 / averageFrameMs : 0;
        const renderer = document.documentElement.dataset.renderer?.toUpperCase() ?? "UNKNOWN";
        const rendererReason = document.documentElement.dataset.rendererReason ?? "GPU PATH UNKNOWN";
        this.latest = {
            enabled: true,
            fps,
            averageFrameMs,
            p95FrameMs: percentile(frameTimes, 0.95),
            averageSimulationMs: average(simulationTimes),
            averageRenderMs: average(renderTimes),
            averageHudMs: average(hudTimes),
            renderer,
            rendererReason,
        };
        this.frames.length = 0;
        this.lastUpdateAt = now;

        this.fpsElement.textContent = `${Math.round(fps)} FPS`;
        this.frameElement.textContent = `${averageFrameMs.toFixed(1)} MS · ${this.latest.p95FrameMs.toFixed(1)} P95`;
        this.detailElement.textContent = `${renderer} · SIM ${this.latest.averageSimulationMs.toFixed(1)} · DRAW ${this.latest.averageRenderMs.toFixed(1)}`;
        this.rendererReasonElement.textContent = rendererReason;
        this.root.classList.toggle("warning", fps < 50 && fps >= 35);
        this.root.classList.toggle("critical", fps < 35);
    }

    snapshot(): Readonly<PerformanceSnapshot> {
        return this.latest;
    }
}
