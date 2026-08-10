// NEONLEAP DOM shell: menu, HUD, pause, results, Upgrade Bay, missions,
// supply drop, settings. The canvas paints the city; this layer is glass
// panels and neon chips over it. Every interactive element lives here — the
// gameplay "button" is the whole screen (tap = jump, hold = higher).

import { POWERUP_LABELS } from "../game/scene.ts";
import type { RunnerSnapshot, UpgradeId } from "../game/core.ts";
import type { CommerceProductId, ProductCommerceView } from "../systems/commerce.ts";
import type { DailyRewardsView } from "../systems/dailyRewards.ts";
import type { LeaderboardPeriod, LeaderboardView } from "../systems/leaderboard.ts";
import type { MissionView } from "../systems/missions.ts";
import type { SecondWindView } from "../systems/rewardedAds.ts";
import type { GameRecords, GameSettings } from "../systems/save.ts";
import type { FtueHint } from "./ftue.ts";

export interface ResultsSummary {
    distance: number;
    score: number;
    cellsEarned: number;
    nearMisses: number;
    smashes: number;
    maxFlow: number;
    bestDistance: number;
    newBest: boolean;
    cause: "fall" | "billboard" | "ended";
    revives: number;
}

export interface UpgradeRowView {
    id: UpgradeId;
    name: string;
    description: string;
    level: number;
    cap: number;
    cost: number | null;
    affordable: boolean;
}

export interface UiProviders {
    wallet(): number;
    records(): GameRecords;
    upgrades(): UpgradeRowView[];
    missions(): MissionView[];
    unclaimedMissions(): number;
    daily(): DailyRewardsView;
    secondWind(): SecondWindView;
    products(): ProductCommerceView[];
}

export interface UiHooks {
    onPlay(): void;
    onRetry(rewardedInteracted: boolean): void;
    onMenu(rewardedInteracted: boolean): void;
    onPause(): void;
    onResume(): void;
    onEndRun(): void;
    onHeld(held: boolean): void;
    onSettingsChanged(settings: GameSettings): void;
    onDailyReminderChanged(enabled: boolean): Promise<string>;
    onReplayTutorial(): void;
    onBuyUpgrade(id: UpgradeId): string;
    onClaimMission(id: string): Promise<string>;
    onClaimDaily(): Promise<string>;
    onPurchaseProduct(id: CommerceProductId): Promise<string>;
    onClaimSecondWind(): Promise<{ granted: boolean; message: string }>;
    onMonetizationSurfaceViewed(surfaceId: string): void;
    onAdOfferViewed(status: string): void;
    onUiSound(kind: "tap" | "confirm"): void;
    onLoadLeaderboard(period: LeaderboardPeriod): Promise<LeaderboardView>;
}

type ScreenName = "menu" | "hud" | "pause" | "results" | "upgrades" | "missions" | "daily" | "leaderboard" | "settings";

const UPGRADE_COPY: Readonly<Record<UpgradeId, { name: string; description: string }>> = {
    capacitor: { name: "CAPACITOR", description: "Powerup duration +12% per level" },
    luckyCoil: { name: "LUCKY COIL", description: "Powerups appear 15% more often per level" },
    magnetCore: { name: "MAGNET CORE", description: "Magnet reach +20% per level" },
    flowGrid: { name: "FLOW GRID", description: "Flow charges 10% faster per level" },
    headStart: { name: "HEAD START", description: "Begin runs 250 m down the track per level" },
};

function el<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`Missing UI node ${selector}`);
    return found;
}

export class UiController {
    private readonly root: HTMLElement;
    /** Every scrolling sheet body, for the edge-fade bookkeeping. */
    private scrollBodies: HTMLElement[] = [];
    private scrollFadeFrame = 0;
    private readonly hooks: UiHooks;
    private readonly providers: UiProviders;
    private settings: GameSettings;
    private screen: ScreenName = "menu";
    private returnTo: "menu" | "pause" | "results" = "menu";
    private held = false;
    private adVisible = false;
    private rewardedInteracted = false;
    private toastTimer = 0;
    private milestoneTimer = 0;
    private lastFlowTier = 1;
    private secondWindBusy = false;
    private leaderboardPeriod: LeaderboardPeriod = "alltime";
    private leaderboardToken = 0;

    constructor(settings: GameSettings, hooks: UiHooks, providers: UiProviders) {
        this.settings = { ...settings };
        this.hooks = hooks;
        this.providers = providers;
        const root = document.getElementById("ui-root");
        if (!root) throw new Error("Missing #ui-root");
        this.root = root;
        this.build();
        this.bindScrollFades();
        this.bindInput();
        this.showMenu();
    }

    /* ------------------------------------------------------------------ dom */

    private build(): void {
        this.root.innerHTML = `
            <section id="screen-menu" class="screen">
                <div class="wordmark">NEON<em>LEAP</em></div>
                <div class="tagline">ONE TAP · ONE CITY · NO BRAKES</div>
                <div class="menu-stats" data-menu-stats></div>
                <button class="btn btn-primary" data-play>RUN</button>
                <div class="menu-row">
                    <span class="badge-host"><button class="btn" data-open-upgrades>UPGRADE BAY</button></span>
                    <span class="badge-host"><button class="btn" data-open-missions>MISSIONS</button><span class="badge" data-mission-badge hidden></span></span>
                    <span class="badge-host"><button class="btn" data-open-daily>SUPPLY DROP</button><span class="badge" data-daily-badge hidden>!</span></span>
                    <button class="btn" data-open-leaderboard>RANKS</button>
                    <button class="btn btn-ghost" data-open-settings>SETTINGS</button>
                </div>
                <div class="menu-version">NEONLEAP v${__APP_VERSION__}</div>
            </section>

            <section id="screen-hud" class="screen">
                <div class="hud-top">
                    <div>
                        <div class="hud-distance"><span data-hud-distance>0</span><small> M</small></div>
                        <div class="hud-score" data-hud-score>SCORE 0</div>
                    </div>
                    <div class="hud-right">
                        <div class="flow-meter">
                            <div class="flow-tier" data-flow-tier>×1</div>
                            <div class="flow-pips" data-flow-pips></div>
                        </div>
                        <button class="hud-pause" data-pause aria-label="Pause">II</button>
                    </div>
                </div>
                <div class="hud-chips" data-chips></div>
                <div class="hud-chain" data-chain></div>
                <div class="coach" data-coach hidden></div>
            </section>

            <section id="screen-pause" class="screen sheet">
                <div class="panel">
                    <div class="panel-head">
                        <div class="panel-title">PAUSED</div>
                        <div class="hairline"></div>
                    </div>
                    <div class="panel-foot">
                        <div class="sheet-actions">
                            <button class="btn btn-primary" data-resume>RESUME</button>
                        </div>
                        <div class="sheet-actions">
                            <button class="btn btn-ghost" data-end-run>END RUN</button>
                            <button class="btn btn-ghost" data-pause-settings>SETTINGS</button>
                        </div>
                    </div>
                </div>
            </section>

            <section id="screen-results" class="screen sheet sheet-wide">
                <div class="panel">
                    <div class="panel-head">
                        <div class="stamp-best" data-new-best hidden>NEW BEST</div>
                        <div class="results-distance"><span data-results-distance>0</span><small> M</small></div>
                        <div class="death-cause" data-death-cause></div>
                    </div>
                    <div class="panel-body">
                        <div class="results-grid">
                            <div class="stat"><b data-results-score>0</b><span>SCORE</span></div>
                            <div class="stat cells"><b data-results-cells>+0</b><span>CELLS</span></div>
                            <div class="stat"><b data-results-nearmiss>0</b><span>NEAR-MISS</span></div>
                            <div class="stat"><b data-results-flow>×1</b><span>TOP FLOW</span></div>
                        </div>
                        <div class="second-wind" data-second-wind>
                            <button class="btn btn-magenta" data-second-wind-action>WATCH · SECOND WIND</button>
                            <div class="status" data-second-wind-status></div>
                        </div>
                        <div data-results-missions></div>
                    </div>
                    <div class="panel-foot">
                        <div class="sheet-actions">
                            <button class="btn btn-primary" data-retry>RUN AGAIN</button>
                            <button class="btn btn-ghost" data-to-menu>MENU</button>
                        </div>
                    </div>
                </div>
            </section>

            <section id="screen-upgrades" class="screen sheet sheet-wide">
                <div class="panel">
                    <div class="panel-head">
                        <div class="panel-title">UPGRADE BAY</div>
                        <div class="wallet-line"><b data-wallet>0</b> CELLS BANKED</div>
                        <div class="hairline"></div>
                    </div>
                    <div class="panel-body">
                        <div class="row-list" data-upgrade-rows></div>
                        <div class="hairline"></div>
                        <div class="shop-row" data-shop-row></div>
                    </div>
                    <div class="panel-foot">
                        <div class="sheet-actions"><button class="btn" data-back>BACK</button></div>
                    </div>
                </div>
            </section>

            <section id="screen-missions" class="screen sheet sheet-wide">
                <div class="panel">
                    <div class="panel-head">
                        <div class="panel-title">TONIGHT'S MISSIONS</div>
                        <div class="daily-note" data-missions-note></div>
                        <div class="hairline"></div>
                    </div>
                    <div class="panel-body">
                        <div class="row-list" data-mission-rows></div>
                    </div>
                    <div class="panel-foot">
                        <div class="sheet-actions"><button class="btn" data-back>BACK</button></div>
                    </div>
                </div>
            </section>

            <section id="screen-daily" class="screen sheet">
                <div class="panel">
                    <div class="panel-head">
                        <div class="panel-title">NIGHTLY SUPPLY DROP</div>
                        <div class="daily-note" data-daily-note></div>
                        <div class="hairline"></div>
                    </div>
                    <div class="panel-body">
                        <div class="daily-track" data-daily-track></div>
                    </div>
                    <div class="panel-foot">
                        <div class="sheet-actions">
                            <button class="btn btn-primary" data-daily-claim>CLAIM</button>
                            <button class="btn btn-ghost" data-back>BACK</button>
                        </div>
                    </div>
                </div>
            </section>

            <section id="screen-leaderboard" class="screen sheet sheet-wide">
                <div class="panel">
                    <div class="panel-head">
                        <div class="panel-title">RANKS</div>
                        <div class="period-tabs">
                            <button class="btn period-tab" data-period="alltime">ALL TIME</button>
                            <button class="btn period-tab" data-period="daily">TODAY</button>
                        </div>
                        <div class="daily-note" data-leaderboard-note></div>
                        <div class="hairline"></div>
                    </div>
                    <div class="panel-body">
                        <div data-leaderboard-rows></div>
                    </div>
                    <div class="panel-foot">
                        <div class="sheet-actions"><button class="btn" data-back>BACK</button></div>
                    </div>
                </div>
            </section>

            <section id="screen-settings" class="screen sheet sheet-wide">
                <div class="panel">
                    <div class="panel-head">
                        <div class="panel-title">SETTINGS</div>
                        <div class="hairline"></div>
                    </div>
                    <div class="panel-body">
                        <div class="row-list row-list-two-up" data-setting-rows></div>
                    </div>
                    <div class="panel-foot">
                        <div class="sheet-actions">
                            <button class="btn btn-ghost" data-replay-tutorial>REPLAY TUTORIAL</button>
                            <button class="btn" data-back>BACK</button>
                        </div>
                    </div>
                </div>
            </section>

            <div id="rotate-overlay">
                <div class="phone"></div>
                <div class="copy">ROTATE TO PLAY</div>
            </div>
            <div id="toast"></div>
            <div id="milestone"><div class="big"></div><div class="small"></div></div>
        `;

        el(this.root, "[data-play]").addEventListener("click", () => {
            this.hooks.onUiSound("confirm");
            this.hooks.onPlay();
        });
        el(this.root, "[data-pause]").addEventListener("pointerdown", (event) => event.stopPropagation());
        el(this.root, "[data-pause]").addEventListener("click", (event) => {
            event.stopPropagation();
            this.hooks.onPause();
        });
        el(this.root, "[data-resume]").addEventListener("click", () => this.hooks.onResume());
        el(this.root, "[data-end-run]").addEventListener("click", () => this.hooks.onEndRun());
        el(this.root, "[data-pause-settings]").addEventListener("click", () => this.openSettings("pause"));
        el(this.root, "[data-retry]").addEventListener("click", () => {
            this.hooks.onUiSound("confirm");
            this.hooks.onRetry(this.rewardedInteracted);
        });
        el(this.root, "[data-to-menu]").addEventListener("click", () => this.hooks.onMenu(this.rewardedInteracted));
        el(this.root, "[data-open-upgrades]").addEventListener("click", () => this.openUpgrades());
        el(this.root, "[data-open-missions]").addEventListener("click", () => this.openMissions());
        el(this.root, "[data-open-daily]").addEventListener("click", () => this.openDaily());
        el(this.root, "[data-open-leaderboard]").addEventListener("click", () => this.openLeaderboard());
        el(this.root, "[data-open-settings]").addEventListener("click", () => this.openSettings("menu"));
        for (const tab of this.root.querySelectorAll<HTMLButtonElement>(".period-tab")) {
            tab.addEventListener("click", () => {
                const period = tab.dataset.period === "daily" ? "daily" : "alltime";
                if (period === this.leaderboardPeriod) return;
                this.leaderboardPeriod = period;
                this.hooks.onUiSound("tap");
                void this.refreshLeaderboard();
            });
        }
        el(this.root, "[data-replay-tutorial]").addEventListener("click", () => {
            this.hooks.onReplayTutorial();
            this.toast("TUTORIAL RE-ARMED FOR THE NEXT RUN");
        });
        el(this.root, "[data-daily-claim]").addEventListener("click", () => {
            void this.hooks.onClaimDaily().then((message) => {
                this.toast(message);
                this.renderDaily();
                this.refreshMeta();
            });
        });
        el(this.root, "[data-second-wind-action]").addEventListener("click", () => void this.claimSecondWind());
        for (const back of this.root.querySelectorAll("[data-back]")) {
            back.addEventListener("click", () => {
                this.hooks.onUiSound("tap");
                this.closeSheet();
            });
        }
    }

    /* ---------------------------------------------------------------- input */

    /**
     * Marks each scrolling panel body with which edges still have content past
     * them, so the CSS can fade exactly those edges. Re-measured on scroll, on
     * resize, and whenever a sheet's rows are re-rendered — a fade that lies
     * about there being more below is worse than no fade at all.
     */
    private bindScrollFades(): void {
        for (const body of this.root.querySelectorAll<HTMLElement>(".panel-body")) {
            this.scrollBodies.push(body);
            body.addEventListener("scroll", () => this.updateScrollFade(body), { passive: true });
            // Sheets re-render their rows on claim, purchase and leaderboard
            // load, which changes the scroll height. Watching the subtree keeps
            // this correct without every render method having to remember.
            new MutationObserver(() => this.queueScrollFadeRefresh()).observe(body, {
                childList: true,
                subtree: true,
            });
        }
        window.addEventListener("resize", () => this.queueScrollFadeRefresh());
        this.refreshScrollFades();
    }

    private queueScrollFadeRefresh(): void {
        if (this.scrollFadeFrame) return;
        this.scrollFadeFrame = requestAnimationFrame(() => {
            this.scrollFadeFrame = 0;
            this.refreshScrollFades();
        });
    }

    private updateScrollFade(body: HTMLElement): void {
        // 1px of slack absorbs sub-pixel layout rounding, which would otherwise
        // leave a permanent bottom fade on a body that is already fully shown.
        const hiddenAbove = body.scrollTop > 1;
        const hiddenBelow = body.scrollTop + body.clientHeight < body.scrollHeight - 1;
        const overflow = hiddenAbove && hiddenBelow ? "both" : hiddenAbove ? "top" : hiddenBelow ? "bottom" : "none";
        body.dataset.overflow = overflow;
    }

    /** Called after any sheet re-renders its rows, since that changes height. */
    private refreshScrollFades(): void {
        for (const body of this.scrollBodies) this.updateScrollFade(body);
    }

    private bindInput(): void {
        const isJumpSurface = (target: EventTarget | null): boolean => {
            if (this.screen !== "hud" || this.adVisible) return false;
            return !(target instanceof Element && target.closest("button"));
        };
        window.addEventListener(
            "pointerdown",
            (event) => {
                if (!isJumpSurface(event.target)) return;
                this.setHeld(true);
            },
            { passive: true },
        );
        const release = (): void => this.setHeld(false);
        window.addEventListener("pointerup", release, { passive: true });
        window.addEventListener("pointercancel", release, { passive: true });
        window.addEventListener("blur", release);
        window.addEventListener("keydown", (event) => {
            if (event.repeat) return;
            if (event.code === "Space" || event.code === "ArrowUp" || event.code === "KeyW") {
                if (this.screen === "hud" && !this.adVisible) {
                    event.preventDefault();
                    this.setHeld(true);
                }
            } else if (event.code === "Escape" || event.code === "KeyP") {
                if (this.screen === "hud") this.hooks.onPause();
                else if (this.screen === "pause") this.hooks.onResume();
            }
        });
        window.addEventListener("keyup", (event) => {
            if (event.code === "Space" || event.code === "ArrowUp" || event.code === "KeyW") release();
        });
    }

    private setHeld(held: boolean): void {
        if (this.held === held) return;
        this.held = held;
        this.hooks.onHeld(held);
    }

    /* -------------------------------------------------------------- screens */

    private show(name: ScreenName): void {
        this.screen = name;
        for (const section of this.root.querySelectorAll<HTMLElement>(".screen")) {
            section.classList.toggle("visible", section.id === `screen-${name}`);
        }
        if (name !== "hud") this.setHeld(false);
        // A hidden screen is display:none, so its bodies measure as zero-height.
        // The fades can only be worked out once the screen is actually up.
        this.refreshScrollFades();
    }

    showMenu(): void {
        this.refreshMeta();
        this.show("menu");
    }

    showRunning(): void {
        this.show("hud");
    }

    showPause(): void {
        this.show("pause");
    }

    showResults(summary: ResultsSummary): void {
        this.rewardedInteracted = false;
        this.secondWindBusy = false;
        el(this.root, "[data-results-distance]").textContent = String(summary.distance);
        el(this.root, "[data-new-best]").hidden = !summary.newBest;
        el(this.root, "[data-death-cause]").textContent =
            summary.cause === "billboard"
                ? "FULL-SPEED BILLBOARD FACE-PLANT"
                : summary.cause === "fall"
                  ? "THE GAP WON THIS ONE"
                  : "RUN BANKED";
        el(this.root, "[data-results-score]").textContent = summary.score.toLocaleString("en-US");
        el(this.root, "[data-results-cells]").textContent = `+${summary.cellsEarned}`;
        el(this.root, "[data-results-nearmiss]").textContent = String(summary.nearMisses);
        el(this.root, "[data-results-flow]").textContent = `×${summary.maxFlow}`;
        this.renderSecondWind();
        this.renderResultsMissions();
        this.show("results");
    }

    /* Sheets over the menu (or pause). */

    private closeSheet(): void {
        if (this.returnTo === "pause") this.showPause();
        else if (this.returnTo === "results") this.show("results");
        else this.showMenu();
    }

    private openUpgrades(): void {
        this.returnTo = "menu";
        this.hooks.onUiSound("tap");
        this.hooks.onMonetizationSurfaceViewed("upgrade_bay");
        this.renderUpgrades();
        this.show("upgrades");
    }

    private openMissions(): void {
        this.returnTo = "menu";
        this.hooks.onUiSound("tap");
        this.renderMissions();
        this.show("missions");
    }

    private openDaily(): void {
        this.returnTo = "menu";
        this.hooks.onUiSound("tap");
        this.renderDaily();
        this.show("daily");
    }

    /** Shows the board screen without triggering a load (development QA). */
    showLeaderboardScreen(): void {
        this.show("leaderboard");
    }

    private openLeaderboard(): void {
        this.returnTo = "menu";
        this.hooks.onUiSound("tap");
        this.show("leaderboard");
        void this.refreshLeaderboard();
    }

    /**
     * Loads the selected board. Every load carries a token so a slow response
     * for a period the player already switched away from is discarded rather
     * than painted over the newer one.
     */
    private async refreshLeaderboard(): Promise<void> {
        const requestId = this.leaderboardToken + 1;
        this.leaderboardToken = requestId;
        for (const tab of this.root.querySelectorAll<HTMLButtonElement>(".period-tab")) {
            tab.classList.toggle("active", tab.dataset.period === this.leaderboardPeriod);
        }
        el(this.root, "[data-leaderboard-note]").textContent = "LOADING…";
        el(this.root, "[data-leaderboard-rows]").innerHTML = "";
        const view = await this.hooks.onLoadLeaderboard(this.leaderboardPeriod);
        if (requestId !== this.leaderboardToken) return;
        this.renderLeaderboard(view);
    }

    /** Public so development QA can screenshot a populated board. */
    renderLeaderboard(view: LeaderboardView): void {
        el(this.root, "[data-leaderboard-note]").textContent = view.message
            ? view.message
            : view.myRank !== null
              ? `YOUR RANK ${view.myRank} OF ${view.totalPlayers.toLocaleString("en-US")}`
              : `${view.totalPlayers.toLocaleString("en-US")} RUNNERS RANKED`;
        const rows = el(this.root, "[data-leaderboard-rows]");
        rows.innerHTML = "";
        for (const row of view.rows) {
            const node = document.createElement("div");
            node.className = `rank-row${row.isYou ? " you" : ""}`;
            node.innerHTML = `
                <span class="rank-place">${row.rank ?? "—"}</span>
                <span class="rank-name"></span>
                <span class="rank-distance">${row.distance.toLocaleString("en-US")} M</span>
            `;
            // Usernames come from other players: never inject them as markup.
            el(node, ".rank-name").textContent = row.name;
            rows.appendChild(node);
        }
    }

    private openSettings(from: "menu" | "pause"): void {
        this.returnTo = from;
        this.hooks.onUiSound("tap");
        this.renderSettings();
        this.show("settings");
    }

    /* ------------------------------------------------------------ rendering */

    refreshMeta(): void {
        const records = this.providers.records();
        const wallet = this.providers.wallet();
        el(this.root, "[data-menu-stats]").innerHTML =
            `<span>BEST <b>${records.bestDistance} M</b></span><span>CELLS <b>${wallet.toLocaleString("en-US")}</b></span>` +
            `<span>RUNS <b>${records.totalRuns}</b></span>`;
        const unclaimed = this.providers.unclaimedMissions();
        const missionBadge = el(this.root, "[data-mission-badge]");
        missionBadge.hidden = unclaimed === 0;
        missionBadge.textContent = String(unclaimed);
        el(this.root, "[data-daily-badge]").hidden = !this.providers.daily().claimable;
    }

    private renderUpgrades(): void {
        el(this.root, "[data-wallet]").textContent = this.providers.wallet().toLocaleString("en-US");
        const rows = el(this.root, "[data-upgrade-rows]");
        rows.innerHTML = "";
        for (const upgrade of this.providers.upgrades()) {
            const copy = UPGRADE_COPY[upgrade.id];
            const row = document.createElement("div");
            row.className = "upgrade-row";
            const pips = Array.from(
                { length: upgrade.cap },
                (_, index) => `<i class="${index < upgrade.level ? "on" : ""}"></i>`,
            ).join("");
            row.innerHTML = `
                <div class="upgrade-info">
                    <div class="upgrade-name">${copy.name}</div>
                    <div class="upgrade-desc">${copy.description}</div>
                    <div class="upgrade-pips">${pips}</div>
                </div>
                <button class="btn upgrade-buy"></button>
            `;
            const buy = el<HTMLButtonElement>(row, "button");
            if (upgrade.cost === null) {
                buy.textContent = "MAXED";
                buy.disabled = true;
            } else {
                buy.textContent = `${upgrade.cost} CELLS`;
                buy.disabled = !upgrade.affordable;
                buy.addEventListener("click", () => {
                    const message = this.hooks.onBuyUpgrade(upgrade.id);
                    this.toast(message);
                    this.renderUpgrades();
                    this.refreshMeta();
                });
            }
            rows.appendChild(row);
        }
        const shop = el(this.root, "[data-shop-row]");
        shop.innerHTML = "";
        for (const product of this.providers.products()) {
            if (!product.visible) continue;
            const card = document.createElement("div");
            card.className = "shop-card";
            card.innerHTML = `
                <div class="name">${product.name}</div>
                <div class="desc">${
                    product.productId === "neon_core"
                        ? "No interstitials, ever. +25% cells from every source. Ion-white trail."
                        : "500 cells, instantly. Everything stays earnable in play."
                }</div>
                <button class="btn"></button>
            `;
            const buy = el<HTMLButtonElement>(card, "button");
            buy.textContent = product.owned ? "OWNED" : product.priceLabel;
            buy.disabled = !product.purchasable;
            if (!product.purchasable && !product.owned) {
                const status = document.createElement("div");
                status.className = "desc";
                status.textContent = product.statusLabel;
                card.appendChild(status);
            }
            buy.addEventListener("click", () => {
                void this.hooks.onPurchaseProduct(product.productId).then((message) => {
                    this.toast(message);
                    this.renderUpgrades();
                    this.refreshMeta();
                });
            });
            shop.appendChild(card);
        }
        if (shop.childElementCount === 0) {
            shop.innerHTML = `<div class="daily-note">SUPPLY SHOP UNLOCKS AFTER YOUR FIRST RUN</div>`;
        }
    }

    private missionRow(mission: MissionView, onClaimed: () => void): HTMLElement {
        const row = document.createElement("div");
        row.className = `mission-row${mission.claimed ? " claimed" : ""}`;
        const percent = Math.round((mission.progress / mission.target) * 100);
        row.innerHTML = `
            <div class="mission-info">
                <div class="mission-label">${mission.label}</div>
                <div class="mission-bar"><i style="width:${percent}%"></i></div>
                <div class="mission-progress">${mission.progress} / ${mission.target} · ${mission.reward} CELLS</div>
            </div>
            <button class="btn mission-claim"></button>
        `;
        const claim = el<HTMLButtonElement>(row, "button");
        if (mission.claimed) {
            claim.textContent = "CLAIMED";
            claim.disabled = true;
        } else if (mission.complete) {
            claim.textContent = "CLAIM";
            claim.classList.add("ready");
            claim.addEventListener("click", () => {
                claim.disabled = true;
                void this.hooks.onClaimMission(mission.id).then((message) => {
                    this.toast(message);
                    onClaimed();
                    this.refreshMeta();
                });
            });
        } else {
            claim.textContent = "IN PLAY";
            claim.disabled = true;
        }
        return row;
    }

    private renderMissions(): void {
        const rows = el(this.root, "[data-mission-rows]");
        const missions = this.providers.missions();
        el(this.root, "[data-missions-note]").textContent =
            missions.length > 0 ? "THREE FRESH MISSIONS EVERY NIGHT" : "MISSIONS DEAL ONCE THE CLOCK SYNCS";
        rows.innerHTML = "";
        for (const mission of missions) {
            rows.appendChild(this.missionRow(mission, () => this.renderMissions()));
        }
    }

    private renderResultsMissions(): void {
        const host = el(this.root, "[data-results-missions]");
        host.innerHTML = "";
        for (const mission of this.providers.missions()) {
            host.appendChild(this.missionRow(mission, () => this.renderResultsMissions()));
        }
    }

    private renderDaily(): void {
        const view = this.providers.daily();
        el(this.root, "[data-daily-note]").textContent = `${view.nextLabel} · ${view.authorityLabel}`;
        const track = el(this.root, "[data-daily-track]");
        track.innerHTML = "";
        for (const [index, reward] of view.rewards.entries()) {
            const day = document.createElement("div");
            const claimed = index < view.currentIndex || (index === view.currentIndex && view.claimedToday);
            day.className = `daily-day${claimed ? " claimed" : ""}${index === view.currentIndex && !view.claimedToday ? " current" : ""}`;
            day.innerHTML = `<div class="n">NIGHT ${reward.day}</div><div class="v">${reward.cells}</div>`;
            track.appendChild(day);
        }
        el<HTMLButtonElement>(this.root, "[data-daily-claim]").disabled = !view.claimable;
    }

    private settingRow(label: string, hint: string, value: boolean, onToggle: (next: boolean) => void): HTMLElement {
        const row = document.createElement("div");
        row.className = "setting-row";
        row.innerHTML = `<label>${label}<span class="hint">${hint}</span></label><button class="toggle${value ? " on" : ""}" role="switch" aria-checked="${value}" aria-label="${label}"></button>`;
        const toggle = el<HTMLButtonElement>(row, ".toggle");
        toggle.addEventListener("click", () => {
            const next = !toggle.classList.contains("on");
            toggle.classList.toggle("on", next);
            toggle.setAttribute("aria-checked", String(next));
            this.hooks.onUiSound("tap");
            onToggle(next);
        });
        return row;
    }

    private renderSettings(): void {
        const rows = el(this.root, "[data-setting-rows]");
        rows.innerHTML = "";
        const push = (patch: Partial<GameSettings>): void => {
            this.settings = { ...this.settings, ...patch };
            this.hooks.onSettingsChanged(this.settings);
        };
        rows.appendChild(
            this.settingRow("MUSIC", "96 BPM synthwave, made by code", this.settings.musicEnabled, (on) =>
                push({ musicEnabled: on }),
            ),
        );
        rows.appendChild(
            this.settingRow("SOUND FX", "Jumps, cells, and near-misses", this.settings.sfxEnabled, (on) =>
                push({ sfxEnabled: on }),
            ),
        );
        rows.appendChild(
            this.settingRow("HAPTICS", "Landing thumps on supported devices", this.settings.hapticsEnabled, (on) =>
                push({ hapticsEnabled: on }),
            ),
        );
        rows.appendChild(
            this.settingRow(
                "REDUCED MOTION",
                "No shake, fewer particles — same game",
                this.settings.reducedMotion,
                (on) => push({ reducedMotion: on }),
            ),
        );
        rows.appendChild(
            this.settingRow(
                "SUPPLY DROP REMINDER",
                "One nudge when tomorrow's drop lands",
                this.settings.dailyReminder,
                (on) => {
                    push({ dailyReminder: on });
                    void this.hooks.onDailyReminderChanged(on).then((message) => this.toast(message));
                },
            ),
        );
        rows.appendChild(
            this.settingRow("PERFORMANCE HUD", "Frame timing overlay", this.settings.performanceHud, (on) =>
                push({ performanceHud: on }),
            ),
        );
    }

    private renderSecondWind(): void {
        const view = this.providers.secondWind();
        const host = el(this.root, "[data-second-wind]");
        host.classList.toggle("visible", view.visible);
        if (!view.visible) return;
        const action = el<HTMLButtonElement>(this.root, "[data-second-wind-action]");
        action.textContent = view.action || "WATCH · SECOND WIND";
        action.disabled = !view.enabled || this.secondWindBusy;
        el(this.root, "[data-second-wind-status]").textContent = view.status;
        this.hooks.onAdOfferViewed(view.enabled ? "available" : view.claimed ? "claimed" : "unavailable");
    }

    private async claimSecondWind(): Promise<void> {
        if (this.secondWindBusy) return;
        this.secondWindBusy = true;
        this.rewardedInteracted = true;
        this.renderSecondWind();
        const outcome = await this.hooks.onClaimSecondWind();
        this.secondWindBusy = false;
        if (!outcome.granted) {
            this.toast(outcome.message);
            this.renderSecondWind();
        }
    }

    /* ------------------------------------------------------------------ hud */

    updateHud(snapshot: RunnerSnapshot): void {
        if (this.screen !== "hud") return;
        el(this.root, "[data-hud-distance]").textContent = String(snapshot.distance);
        el(this.root, "[data-hud-score]").textContent = `SCORE ${snapshot.score.toLocaleString("en-US")}`;

        const tierNode = el(this.root, "[data-flow-tier]");
        tierNode.textContent = `×${snapshot.flow.tier}`;
        if (snapshot.flow.tier !== this.lastFlowTier) {
            this.lastFlowTier = snapshot.flow.tier;
            tierNode.classList.add("bump");
            window.setTimeout(() => tierNode.classList.remove("bump"), 140);
        }
        const pips = el(this.root, "[data-flow-pips]");
        const needed = snapshot.flow.nextAt;
        const have = Math.min(snapshot.flow.points, needed);
        if (pips.childElementCount !== needed) {
            pips.innerHTML = Array.from({ length: needed }, () => "<i></i>").join("");
        }
        for (const [index, pip] of [...pips.children].entries()) {
            pip.classList.toggle("on", index < have && snapshot.flow.tier < 4);
        }

        const chips = el(this.root, "[data-chips]");
        const active = [snapshot.power, snapshot.mobility].filter(
            (slot): slot is NonNullable<typeof slot> => slot !== null,
        );
        const signature = active.map((slot) => `${slot.kind}:${slot.remaining < 0.5 ? "x" : "-"}`).join("|");
        if (chips.dataset.signature !== signature) {
            chips.dataset.signature = signature;
            chips.innerHTML = "";
            for (const slot of active) {
                const chip = document.createElement("div");
                chip.className = `powerup-chip${slot.remaining < 0.5 ? " expiring" : ""}`;
                chip.dataset.kind = slot.kind;
                chip.style.setProperty(
                    "--chip",
                    slot.kind === "overdrive"
                        ? "var(--amber)"
                        : slot.kind === "magnet"
                          ? "var(--cyan)"
                          : slot.kind === "focus"
                            ? "var(--violet)"
                            : slot.kind === "rush"
                              ? "var(--magenta)"
                              : "var(--green)",
                );
                chip.innerHTML = `<div class="chip-fill"></div><span>${POWERUP_LABELS[slot.kind]}</span>`;
                chips.appendChild(chip);
            }
        }
        for (const chip of chips.querySelectorAll<HTMLElement>(".powerup-chip")) {
            const slot = active.find((entry) => entry.kind === chip.dataset.kind);
            const fill = chip.querySelector<HTMLElement>(".chip-fill");
            if (slot && fill) fill.style.transform = `scaleX(${Math.max(0, slot.remaining / slot.total)})`;
        }

        const chain = el(this.root, "[data-chain]");
        chain.classList.toggle("visible", snapshot.pickupChain >= 3);
        if (snapshot.pickupChain >= 3) chain.textContent = `CHAIN ${snapshot.pickupChain}`;
    }

    showCoach(hint: FtueHint): void {
        const coach = el(this.root, "[data-coach]");
        if (!hint) {
            coach.hidden = true;
            return;
        }
        coach.hidden = false;
        coach.textContent = hint === "tap" ? "TAP TO JUMP" : "HOLD FOR HIGHER";
    }

    /* ----------------------------------------------------------- feedback */

    toast(message: string): void {
        const toast = el(this.root, "#toast");
        toast.textContent = message;
        toast.classList.add("visible");
        window.clearTimeout(this.toastTimer);
        this.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2400);
    }

    milestone(big: string, small: string): void {
        const node = el(this.root, "#milestone");
        el(node, ".big").textContent = big;
        el(node, ".small").textContent = small;
        node.classList.add("visible");
        window.clearTimeout(this.milestoneTimer);
        this.milestoneTimer = window.setTimeout(() => node.classList.remove("visible"), 1500);
    }

    handleAdPresentation(visible: boolean): void {
        this.adVisible = visible;
        this.root.style.visibility = visible ? "hidden" : "visible";
        if (!visible) {
            this.setHeld(false);
            window.focus();
        }
    }

    currentScreen(): ScreenName {
        return this.screen;
    }
}
