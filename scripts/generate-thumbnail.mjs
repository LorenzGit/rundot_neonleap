/**
 * Captures the 512×512 store tile FROM THE LIVE GAME so the art can never
 * drift from what ships: headless Chrome opens the menu (wordmark, skyline,
 * rain, the runner idling on a neon rim), the interactive chrome is hidden,
 * and the frame is written straight to public/thumbnail.jpg via `sips`.
 *
 * Needs a dev server on 5191 (npm run dev) and local Chrome.
 */
import { spawnSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const baseUrl = process.argv[2] ?? "http://localhost:5191/?qa=1&renderer=webgl";
const profileDir = await mkdtemp(join(tmpdir(), "neonleap-thumbnail-"));
const chrome = spawn(
    chromePath,
    [
        "--headless=new",
        "--enable-gpu",
        "--mute-audio",
        "--hide-scrollbars",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "about:blank",
    ],
    { stdio: "ignore" },
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let socket;
let nextMessageId = 1;
const pending = new Map();

function command(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = nextMessageId;
        nextMessageId += 1;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(expression) {
    const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
    return response.result?.value;
}

try {
    let port;
    for (let attempt = 0; attempt < 400 && !port; attempt += 1) {
        try {
            port = Number((await readFile(join(profileDir, "DevToolsActivePort"), "utf8")).trim().split("\n")[0]);
        } catch {
            await delay(50);
        }
    }
    const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(baseUrl)}`, {
        method: "PUT",
    }).then((response) => response.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
    });
    socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id && pending.has(message.id)) {
            const entry = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) entry.reject(new Error(message.error.message));
            else entry.resolve(message.result ?? {});
        }
    });
    await command("Runtime.enable");
    await command("Page.enable");
    await command("Emulation.setDeviceMetricsOverride", {
        width: 512,
        height: 512,
        deviceScaleFactor: 2,
        mobile: false,
    });
    await command("Page.navigate", { url: baseUrl });
    for (let attempt = 0; attempt < 400; attempt += 1) {
        if (await evaluate("Boolean(window.__neonleapQa) && !document.getElementById('boot-cover')")) break;
        await delay(50);
    }
    // Menu scene only: wordmark + tagline stay, interactive chrome goes.
    await evaluate(`(() => {
        for (const selector of [".menu-row", ".menu-stats", ".menu-version", "[data-play]"]) {
            for (const node of document.querySelectorAll(selector)) node.style.visibility = "hidden";
        }
        return true;
    })()`);
    await delay(1400);
    const shot = await command("Page.captureScreenshot", { format: "png", fromSurface: true });
    const pngPath = join(profileDir, "thumbnail.png");
    await writeFile(pngPath, Buffer.from(shot.data, "base64"));
    const result = spawnSync("sips", [
        "-z",
        "512",
        "512",
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "88",
        pngPath,
        "--out",
        new URL("../public/thumbnail.jpg", import.meta.url).pathname,
    ]);
    if (result.status !== 0) throw new Error(`sips failed: ${result.stderr}`);
    console.log("public/thumbnail.jpg regenerated from the live menu scene");
} finally {
    try {
        socket?.close();
    } catch {
        // Socket may already be gone.
    }
    chrome.kill("SIGKILL");
    await rm(profileDir, { recursive: true, force: true });
}
