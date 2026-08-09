import { Application } from "pixi.js";

type RendererPreference = "webgpu" | "webgl";
type RendererReason =
    | "WEBGPU ACTIVE"
    | "WEBGPU API NOT EXPOSED"
    | "WEBGPU INIT FAILED"
    | "PIXI SELECTED WEBGL"
    | "FORCED WEBGPU QA"
    | "FORCED WEBGL QA";

/** The night sky at its darkest — painted before the scene takes over. */
const BOOT_BACKGROUND = 0x0b1026;

async function initializeRenderer(host: HTMLElement, preference: RendererPreference): Promise<Application> {
    const width = Math.max(1, host.clientWidth || window.innerWidth);
    const height = Math.max(1, host.clientHeight || window.innerHeight);
    const app = new Application();
    try {
        await app.init({
            preference,
            width,
            height,
            resolution: Math.min(2, window.devicePixelRatio || 1),
            autoDensity: true,
            background: BOOT_BACKGROUND,
            antialias: true,
        });
        return app;
    } catch (error) {
        try {
            app.destroy({ removeView: true }, { children: true });
        } catch {
            // Renderer initialization can fail before a canvas exists.
        }
        throw error;
    }
}

export async function createPixiApp(host: HTMLElement): Promise<Application> {
    const forced = new URLSearchParams(window.location.search).get("renderer");
    const webGpuApiAvailable = Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
    let app: Application;
    let rendererReason: RendererReason;
    if (forced === "webgpu" || forced === "webgl") {
        app = await initializeRenderer(host, forced);
        rendererReason = forced === "webgpu" ? "FORCED WEBGPU QA" : "FORCED WEBGL QA";
    } else if (!webGpuApiAvailable) {
        app = await initializeRenderer(host, "webgl");
        rendererReason = "WEBGPU API NOT EXPOSED";
    } else {
        try {
            app = await initializeRenderer(host, "webgpu");
            rendererReason = "WEBGPU ACTIVE";
        } catch (error) {
            console.warn("[renderer] WebGPU unavailable; falling back to WebGL", error);
            app = await initializeRenderer(host, "webgl");
            rendererReason = "WEBGPU INIT FAILED";
        }
    }

    // renderer.name is Pixi's literal backend string; constructor.name breaks under minification.
    const rendererName = app.renderer.name.toLowerCase().includes("webgpu") ? "webgpu" : "webgl";
    if (rendererName === "webgl" && rendererReason === "WEBGPU ACTIVE") {
        rendererReason = "PIXI SELECTED WEBGL";
    }
    document.documentElement.dataset.renderer = rendererName;
    document.documentElement.dataset.rendererReason = rendererReason;
    app.canvas.dataset.renderer = rendererName;
    app.canvas.dataset.rendererReason = rendererReason;
    app.canvas.setAttribute("aria-label", "NEONLEAP rooftop skyline");
    app.canvas.style.width = "100%";
    app.canvas.style.height = "100%";
    app.canvas.style.display = "block";
    host.appendChild(app.canvas);
    return app;
}
