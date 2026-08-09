/**
 * NEONLEAP headless visual + interaction QA.
 *
 * Needs a dev server (npm run dev, port 5191) and local Chrome. Forces the
 * WebGL renderer — headless WebGPU is unstable — and drives the game through
 * the __neonleapQa bridge plus real DOM clicks and key events:
 *
 *   boot → menu → run (held jumps actually clear gaps) → pause → results →
 *   upgrade bay / missions / supply drop / settings → portrait rotate gate.
 *
 * Screenshots land in docs/qa; the run fails loudly if the sim state does not
 * respond to input.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const baseUrl = process.argv[2] ?? "http://127.0.0.1:5191/?qa=1&renderer=webgl";
const outputDir = resolve(process.argv[3] ?? "docs/qa");
const profileDir = await mkdtemp(join(tmpdir(), "neonleap-visual-qa-"));
const chrome = spawn(
    chromePath,
    [
        "--headless=new",
        "--enable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-default-apps",
        "--mute-audio",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "about:blank",
    ],
    { stdio: "ignore" },
);

let socket;
let nextMessageId = 1;
const pending = new Map();

function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForDevToolsPort() {
    const portFile = join(profileDir, "DevToolsActivePort");
    for (let attempt = 0; attempt < 600; attempt += 1) {
        try {
            const [port] = (await readFile(portFile, "utf8")).trim().split("\n");
            return Number(port);
        } catch {
            await delay(50);
        }
    }
    throw new Error("Chrome DevTools port did not become ready");
}

function command(method, params = {}) {
    return new Promise((resolveCommand, rejectCommand) => {
        const id = nextMessageId;
        nextMessageId += 1;
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        socket.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(expression) {
    const response = await command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (response.exceptionDetails) {
        const details = response.exceptionDetails;
        throw new Error(details.exception?.description ?? details.text);
    }
    return response.result?.value;
}

async function waitFor(expression, label, attempts = 200) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (await evaluate(expression)) return;
        await delay(50);
    }
    throw new Error(`${label} did not become ready`);
}

async function setViewport(width, height) {
    await command("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: true,
        screenWidth: width,
        screenHeight: height,
        screenOrientation: {
            type: width > height ? "landscapePrimary" : "portraitPrimary",
            angle: width > height ? 90 : 0,
        },
    });
}

async function openGame(width, height) {
    await setViewport(width, height);
    await command("Page.navigate", { url: baseUrl });
    await waitFor("document.readyState === 'complete'", "document");
    await waitFor("Boolean(window.__neonleapQa)", "NEONLEAP QA bridge", 400);
    await waitFor('!document.getElementById("boot-cover")', "boot cover lift", 400);
}

async function capture(fileName) {
    await delay(400);
    const result = await command("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
    });
    await writeFile(join(outputDir, fileName), Buffer.from(result.data, "base64"));
    console.log(join(outputDir, fileName));
}

function snapshot() {
    return evaluate("JSON.stringify(window.__neonleapQa.snapshot())").then(JSON.parse);
}

function clickUi(selector) {
    return evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) throw new Error("missing ${selector}");
        node.click();
        return true;
    })()`);
}

/** Hold and release jump through real key events on the window. */
function keyJump(downMs) {
    return evaluate(`(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
        await new Promise((r) => setTimeout(r, ${downMs}));
        window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", bubbles: true }));
        return true;
    })()`);
}

const qaSave = {
    version: 1,
    wallet: { cells: 940 },
    records: {
        bestDistance: 1420,
        bestScore: 20_115,
        totalRuns: 6,
        totalDistance: 6200,
        totalCells: 1180,
        nearMisses: 41,
        smashes: 12,
        deaths: 5,
        revives: 1,
    },
    upgrades: { capacitor: 2, luckyCoil: 1, magnetCore: 0, flowGrid: 0, headStart: 1 },
    missions: { dateKey: "", slots: [] },
    daily: { lastClaimDay: null, totalClaims: 2, claimIds: [] },
    entitlements: { neonCore: false },
    monetization: {
        pendingPurchaseIntent: null,
        redeemedOrderIds: [],
        rewardedAds: { day: null, completedToday: 0, lastCompletedAtMs: 0, claimIds: [] },
        interstitialAds: { day: null, shownToday: 0, lastShownAtMs: 0 },
    },
    settings: {
        musicEnabled: false,
        sfxEnabled: false,
        hapticsEnabled: false,
        reducedMotion: false,
        performanceHud: false,
        dailyReminder: false,
    },
    progress: { controlsSeen: true },
};

const VERSION_TAG = process.env.NEONLEAP_QA_TAG ?? "current";

function shot(name) {
    return `neonleap-${VERSION_TAG}-${name}.png`;
}

try {
    await mkdir(outputDir, { recursive: true });
    const port = await waitForDevToolsPort();
    const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(baseUrl)}`, {
        method: "PUT",
    }).then((response) => response.json());
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolveOpen, rejectOpen) => {
        socket.addEventListener("open", resolveOpen, { once: true });
        socket.addEventListener("error", rejectOpen, { once: true });
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

    /* ------------------------------------------------ phone landscape flow */

    await openGame(852, 393);
    // Seed a veteran save so meta surfaces have content, then reload.
    await evaluate(
        `localStorage.setItem("neonleap.local-save", ${JSON.stringify(JSON.stringify(qaSave))}); location.reload();`,
    );
    await delay(400);
    await waitFor("Boolean(window.__neonleapQa)", "reloaded QA bridge", 400);
    await waitFor('!document.getElementById("boot-cover")', "boot cover", 400);
    await delay(600);
    await capture(shot("menu-phone"));

    // Menu must show the seeded records.
    const menuStats = await evaluate('document.querySelector("[data-menu-stats]").textContent');
    if (!menuStats.includes("1420")) throw new Error(`menu stats missing best distance: ${menuStats}`);

    // Start a run through the real button.
    await clickUi("[data-play]");
    await waitFor('window.__neonleapQa.snapshot().phase === "running"', "run start");
    await delay(700);
    const early = await snapshot();
    if (early.screen !== "hud") throw new Error(`expected hud, got ${early.screen}`);

    // Drive real held jumps; jump at edges and obstacles, not on a timer.
    // The driver is deliberately naive, so it can die — retry until a run
    // reaches the checkpoint distance with the pause test still available.
    const drive = async (untilMetres, maxSteps) => {
        let jumps = 0;
        for (let step = 0; step < maxSteps; step += 1) {
            const state = await snapshot();
            if (state.phase !== "running" || state.distance >= untilMetres) return { ...state, jumps };
            const gapClose = state.nextGapIn >= 0 && state.nextGapIn < state.speed * 0.42;
            const obstacleClose =
                state.nextObstacleIn >= 0 &&
                state.nextObstacleIn < state.speed * 0.3 &&
                state.nextObstacleIn < state.nextGapIn;
            if (state.grounded && (gapClose || obstacleClose)) {
                await keyJump(obstacleClose && !gapClose ? 120 : 320);
                jumps += 1;
            }
            await delay(70);
        }
        return { ...(await snapshot()), jumps };
    };
    let mid = await drive(160, 90);
    for (let attempt = 0; attempt < 3 && mid.phase === "dead"; attempt += 1) {
        await waitFor('window.__neonleapQa.snapshot().screen === "results"', "results before retry", 400);
        await clickUi("[data-retry]");
        await waitFor('window.__neonleapQa.snapshot().phase === "running"', "retry for checkpoint");
        mid = await drive(160, 90);
    }
    if (mid.phase !== "running") throw new Error("the QA driver could not reach 160 m in four attempts");
    if (mid.jumps < 2) throw new Error(`only ${mid.jumps} jumps were dispatched`);
    if (mid.distance < 120) throw new Error(`runner only travelled ${mid.distance} m under input`);
    await capture(shot("run-phone"));

    // Pause overlay.
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true }))');
    await waitFor('window.__neonleapQa.snapshot().screen === "pause"', "pause screen");
    await capture(shot("pause-phone"));
    await clickUi("[data-resume]");
    await waitFor('window.__neonleapQa.snapshot().screen === "hud"', "resume");

    // Keep running a while, then stop jumping: the next gap ends the run.
    await drive(mid.distance + 200, 90);
    await waitFor('window.__neonleapQa.snapshot().phase === "dead"', "death by gap", 600);
    await waitFor('window.__neonleapQa.snapshot().screen === "results"', "results sheet", 400);
    await delay(500);
    const results = await snapshot();
    if (results.distance < 120) throw new Error("results should carry the run distance");
    await capture(shot("results-phone"));

    // One-tap retry restarts a fresh run.
    await clickUi("[data-retry]");
    await waitFor('window.__neonleapQa.snapshot().phase === "running"', "retry run");
    const retried = await snapshot();
    if (retried.distance > 40) throw new Error("retry must start a fresh run");
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true }))');
    await waitFor('window.__neonleapQa.snapshot().screen === "pause"', "pause for exit");
    await clickUi("[data-end-run]");
    await waitFor('window.__neonleapQa.snapshot().screen === "results"', "ended run results");
    await clickUi("[data-to-menu]");
    await waitFor('window.__neonleapQa.snapshot().screen === "menu"', "back to menu");

    // Meta surfaces.
    await clickUi("[data-open-upgrades]");
    await waitFor('window.__neonleapQa.snapshot().screen === "upgrades"', "upgrade bay");
    await capture(shot("upgrades-phone"));
    const wallet = await evaluate('document.querySelector("[data-wallet]").textContent');
    // The seeded 940 plus whatever the QA run just banked.
    if (Number(wallet.replace(/[^0-9]/g, "")) < 940) throw new Error(`upgrade bay wallet shows ${wallet}`);
    await clickUi("#screen-upgrades [data-back]");

    await clickUi("[data-open-missions]");
    await waitFor('window.__neonleapQa.snapshot().screen === "missions"', "missions");
    await capture(shot("missions-phone"));
    await clickUi("#screen-missions [data-back]");

    await clickUi("[data-open-daily]");
    await waitFor('window.__neonleapQa.snapshot().screen === "daily"', "supply drop");
    await capture(shot("daily-phone"));
    await clickUi("#screen-daily [data-back]");

    await clickUi("[data-open-settings]");
    await waitFor('window.__neonleapQa.snapshot().screen === "settings"', "settings");
    await capture(shot("settings-phone"));
    await clickUi("#screen-settings [data-back]");

    // Portrait shows the rotate gate.
    await setViewport(393, 852);
    await delay(600);
    await capture(shot("rotate-portrait"));
    const rotateVisible = await evaluate(
        'getComputedStyle(document.getElementById("rotate-overlay")).display !== "none"',
    );
    if (!rotateVisible) throw new Error("portrait must show the rotate overlay");
    await setViewport(852, 393);
    await delay(400);

    /* --------------------------------------------------------- desktop pass */

    await openGame(1440, 900);
    await delay(600);
    await capture(shot("menu-desktop"));
    await clickUi("[data-play]");
    await waitFor('window.__neonleapQa.snapshot().phase === "running"', "desktop run");
    for (let step = 0; step < 60; step += 1) {
        const state = await snapshot();
        if (state.phase !== "running") break;
        const gapClose = state.nextGapIn >= 0 && state.nextGapIn < state.speed * 0.42;
        const obstacleClose =
            state.nextObstacleIn >= 0 &&
            state.nextObstacleIn < state.speed * 0.3 &&
            state.nextObstacleIn < state.nextGapIn;
        if (state.grounded && (gapClose || obstacleClose)) await keyJump(obstacleClose && !gapClose ? 120 : 320);
        await delay(70);
    }
    if ((await snapshot()).phase === "dead") {
        // A dead driver still proves the desktop run rendered; screenshot as-is.
    }
    await capture(shot("run-desktop"));

    console.log("visual qa ok: boot, menu, run under real input, pause, results, retry, meta sheets, rotate gate");
} finally {
    try {
        socket?.close();
    } catch {
        // Socket may already be gone.
    }
    chrome.kill("SIGKILL");
    await rm(profileDir, { recursive: true, force: true });
}
