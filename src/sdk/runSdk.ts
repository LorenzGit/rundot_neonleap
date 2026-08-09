import type {
    Entitlement,
    LiveOpsConfigResult,
    ShopOrderHistoryResponse,
    ShopPurchaseResponse,
    StorefrontResponse,
    Subscription,
} from "@series-inc/rundot-game-sdk";
import { HapticFeedbackStyle } from "@series-inc/rundot-game-sdk";
import RundotGameAPI from "@series-inc/rundot-game-sdk/api";
import { type EdgeInsets, safeAreaOffsetsForFrame } from "./safeArea.ts";

export interface RunCapabilities {
    host: boolean;
    mock: boolean;
    storage: boolean;
    analytics: boolean;
    haptics: boolean;
    ads: boolean;
    liveops: boolean;
    shop: boolean;
    entitlements: boolean;
    notifications: boolean;
}

const OFFLINE_CAPABILITIES: RunCapabilities = {
    host: false,
    mock: false,
    storage: false,
    analytics: false,
    haptics: false,
    ads: false,
    liveops: false,
    shop: false,
    entitlements: false,
    notifications: false,
};

let ready = false;
let capabilities: RunCapabilities = OFFLINE_CAPABILITIES;
let safeAreaResizeBound = false;
let safeAreaFrame = 0;

function namespaceAvailable(name: string): boolean {
    return typeof (RundotGameAPI as unknown as Record<string, unknown>)[name] === "object";
}

/**
 * Haptics availability read LIVE from DeviceInfo. `enabled` reflects the
 * player's system setting, which can change mid-session, so a cached false at
 * boot must never gate a later buzz.
 */
function hapticsAvailableNow(): boolean {
    if (!ready) return false;
    try {
        const device = RundotGameAPI.system.getDevice();
        return device?.haptics?.supported === true && device?.haptics?.enabled === true;
    } catch {
        return false;
    }
}

function snapshotCapabilities(): RunCapabilities {
    if (!ready) return OFFLINE_CAPABILITIES;
    const environment = RundotGameAPI._environmentData?.capabilities;
    return {
        host: true,
        mock: RundotGameAPI.isMock(),
        storage: namespaceAvailable("appStorage"),
        analytics: namespaceAvailable("analytics"),
        haptics: hapticsAvailableNow(),
        ads: namespaceAvailable("ads") && environment?.ads !== false,
        liveops: namespaceAvailable("liveops"),
        shop: namespaceAvailable("shop") && environment?.purchases === true,
        entitlements: namespaceAvailable("entitlements"),
        notifications: namespaceAvailable("notifications"),
    };
}

export function getRunCapabilities(): Readonly<RunCapabilities> {
    return capabilities;
}

/**
 * Re-read host capabilities. Wired to onAwake (the SDK's "refresh stale data"
 * hook) so a session that started before a grant or attach does not stay
 * frozen on its boot snapshot.
 */
export function refreshRunCapabilities(): Readonly<RunCapabilities> {
    capabilities = snapshotCapabilities();
    return capabilities;
}

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeoutId = 0;
    const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        window.clearTimeout(timeoutId);
    }
}

export async function initSdk(): Promise<boolean> {
    const embedded = window.parent !== window;
    const deadline = performance.now() + (embedded ? 1500 : 0);
    do {
        try {
            if (RundotGameAPI.isAvailable() || RundotGameAPI.isMock()) {
                ready = true;
                break;
            }
        } catch {
            break;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    } while (performance.now() < deadline);

    capabilities = snapshotCapabilities();
    if (!ready) {
        console.info("[runSdk] RUN host unavailable; local fallbacks active");
        // Inside an iframe the host is expected — a cold WebView can simply be
        // slower than the bounded handshake. Keep watching so a late attach
        // upgrades this session instead of stranding it offline until relaunch.
        if (embedded) watchForLateHostAttach();
    }
    return ready;
}

function watchForLateHostAttach(): void {
    const deadline = performance.now() + 30_000;
    const watcher = window.setInterval(() => {
        try {
            if (RundotGameAPI.isAvailable() || RundotGameAPI.isMock()) {
                window.clearInterval(watcher);
                ready = true;
                capabilities = snapshotCapabilities();
                applyRunSafeArea();
                console.info("[runSdk] RUN host attached after the boot handshake; capabilities refreshed");
                return;
            }
        } catch {
            window.clearInterval(watcher);
            return;
        }
        if (performance.now() >= deadline) window.clearInterval(watcher);
    }, 500);
}

export function applyRunSafeArea(): void {
    let safeArea: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
    if (ready) {
        try {
            const hostSafeArea = RundotGameAPI.system.getSafeArea();
            safeArea = {
                top: Math.max(0, Number(hostSafeArea.top) || 0),
                right: Math.max(0, Number(hostSafeArea.right) || 0),
                bottom: Math.max(0, Number(hostSafeArea.bottom) || 0),
                left: Math.max(0, Number(hostSafeArea.left) || 0),
            };
        } catch {
            // Keep CSS env fallbacks.
        }
    }
    const frame = document.getElementById("app-frame");
    if (frame) {
        // The *visible* box, not the layout box. Inside a host webview the two
        // differ, and measuring the frame against the larger one turns a small
        // real inset into one that eats most of the screen.
        const visual = window.visualViewport;
        safeArea = safeAreaOffsetsForFrame(safeArea, frame.getBoundingClientRect(), {
            width: visual?.width ?? window.innerWidth,
            height: visual?.height ?? window.innerHeight,
        });
    }
    const root = document.documentElement;
    root.style.setProperty("--run-safe-top", `${safeArea.top}px`);
    root.style.setProperty("--run-safe-right", `${safeArea.right}px`);
    root.style.setProperty("--run-safe-bottom", `${safeArea.bottom}px`);
    root.style.setProperty("--run-safe-left", `${safeArea.left}px`);
}

export function bindRunSafeArea(): void {
    applyRunSafeArea();
    if (safeAreaResizeBound) return;
    safeAreaResizeBound = true;
    const schedule = (): void => {
        window.cancelAnimationFrame(safeAreaFrame);
        safeAreaFrame = window.requestAnimationFrame(applyRunSafeArea);
    };
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("orientationchange", schedule, { passive: true });
    // A host toolbar sliding away changes the visible box without a resize.
    window.visualViewport?.addEventListener("resize", schedule, { passive: true });
    window.visualViewport?.addEventListener("scroll", schedule, { passive: true });
}

export async function readAppStorage(key: string): Promise<{ ok: boolean; value: string | null }> {
    if (!capabilities.storage) return { ok: false, value: null };
    try {
        return {
            ok: true,
            value: await withTimeout(RundotGameAPI.appStorage.getItem(key), 2000, "appStorage.getItem"),
        };
    } catch (error) {
        console.warn("[runSdk] save read failed", error);
        return { ok: false, value: null };
    }
}

export async function writeAppStorage(key: string, value: string): Promise<boolean> {
    if (!capabilities.storage) return false;
    try {
        await withTimeout(RundotGameAPI.appStorage.setItem(key, value), 2000, "appStorage.setItem");
        return true;
    } catch (error) {
        console.warn("[runSdk] save write failed", error);
        return false;
    }
}

export async function requestServerEpochMs(): Promise<number | null> {
    if (!capabilities.host) return null;
    try {
        const result = await withTimeout(RundotGameAPI.requestTimeAsync(), 2000, "requestTimeAsync");
        return typeof result.serverTime === "number" ? result.serverTime : null;
    } catch (error) {
        console.warn("[runSdk] trusted time unavailable", error);
        return null;
    }
}

export async function fetchLiveOpsConfig(): Promise<LiveOpsConfigResult | null> {
    if (!capabilities.liveops) return null;
    try {
        return await withTimeout(RundotGameAPI.liveops.getConfigAsync(), 3000, "liveops.getConfigAsync");
    } catch (error) {
        console.warn("[runSdk] LiveOps unavailable", error);
        return null;
    }
}

export async function isRewardedAdReady(): Promise<boolean> {
    if (!capabilities.ads) return false;
    try {
        return await withTimeout(RundotGameAPI.ads.isRewardedAdReadyAsync(), 2500, "ads.isRewardedAdReadyAsync");
    } catch (error) {
        console.warn("[runSdk] rewarded ad readiness unavailable", error);
        return false;
    }
}

export async function showRewardedAd(placementId: string, placementName: string): Promise<boolean> {
    if (!capabilities.ads) return false;
    try {
        return await withTimeout(
            RundotGameAPI.ads.showRewardedAdAsync({
                adDisplayId: placementId,
                adDisplayName: placementName,
            }),
            120_000,
            "ads.showRewardedAdAsync",
        );
    } catch (error) {
        console.warn("[runSdk] rewarded ad unavailable", error);
        return false;
    }
}

export async function isInterstitialAdReady(): Promise<boolean> {
    if (!capabilities.ads) return false;
    try {
        return await withTimeout(
            RundotGameAPI.ads.isInterstitialAdReadyAsync(),
            2500,
            "ads.isInterstitialAdReadyAsync",
        );
    } catch (error) {
        console.warn("[runSdk] interstitial ad readiness unavailable", error);
        return false;
    }
}

export async function showInterstitialAd(placementId: string, placementName: string): Promise<boolean> {
    if (!capabilities.ads) return false;
    try {
        return await withTimeout(
            RundotGameAPI.ads.showInterstitialAd({
                adDisplayId: placementId,
                adDisplayName: placementName,
            }),
            120_000,
            "ads.showInterstitialAd",
        );
    } catch (error) {
        console.warn("[runSdk] interstitial ad unavailable", error);
        return false;
    }
}

export async function fetchShopCatalog(): Promise<StorefrontResponse | null> {
    if (!capabilities.shop || capabilities.mock) return null;
    try {
        return await withTimeout(RundotGameAPI.shop.getCatalog(), 3000, "shop.getCatalog");
    } catch (error) {
        console.warn("[runSdk] shop catalog unavailable", error);
        return null;
    }
}

export async function fetchEntitlements(): Promise<Entitlement[] | null> {
    if (!capabilities.entitlements || capabilities.mock) return null;
    try {
        return await withTimeout(RundotGameAPI.entitlements.listEntitlements(), 3000, "entitlements.list");
    } catch (error) {
        console.warn("[runSdk] entitlements unavailable", error);
        return null;
    }
}

export async function purchaseShopItem(itemId: string, idempotencyKey: string): Promise<ShopPurchaseResponse> {
    if (!capabilities.shop || capabilities.mock) throw new Error("RUN SHOP UNAVAILABLE");
    return RundotGameAPI.shop.purchase(itemId, idempotencyKey);
}

export async function fetchShopOrderHistory(): Promise<ShopOrderHistoryResponse> {
    if (!capabilities.shop || capabilities.mock) throw new Error("RUN SHOP UNAVAILABLE");
    return withTimeout(RundotGameAPI.shop.getOrderHistory({ limit: 50 }), 3500, "shop.getOrderHistory");
}

/* ------------------------------------------------------------ notifications */

/**
 * Whether the player has local notifications switched on at the platform level.
 * Fails closed: an unavailable host means "no", never an optimistic yes.
 */
export async function localNotificationsEnabled(): Promise<boolean> {
    if (!capabilities.notifications) return false;
    try {
        return await withTimeout(
            RundotGameAPI.notifications.isLocalNotificationsEnabled(),
            2500,
            "notifications.enabled",
        );
    } catch (error) {
        console.warn("[runSdk] notification permission unreadable", error);
        return false;
    }
}

/** Asks the host to turn local notifications on. Only ever from a gesture. */
export async function setLocalNotificationsEnabled(enabled: boolean): Promise<boolean> {
    if (!capabilities.notifications) return false;
    try {
        return await withTimeout(
            RundotGameAPI.notifications.setLocalNotificationsEnabled(enabled),
            8000,
            "notifications.setEnabled",
        );
    } catch (error) {
        console.warn("[runSdk] notification permission unavailable", error);
        return false;
    }
}

/**
 * Schedules one local notification. `notificationId` is stable per reminder, so
 * re-scheduling replaces rather than stacks. Returns whether the host actually
 * took it — a skipped channel is not a scheduled notification.
 */
export async function scheduleLocalNotification(input: {
    notificationId: string;
    title: string;
    body: string;
    delaySeconds: number;
    collapseKey?: string;
}): Promise<boolean> {
    if (!capabilities.notifications) return false;
    try {
        const result = await withTimeout(
            RundotGameAPI.notifications.submitMessageAsync({
                channels: ["local"],
                notificationId: input.notificationId,
                title: input.title,
                body: input.body,
                delaySeconds: Math.max(1, Math.round(input.delaySeconds)),
                collapseKey: input.collapseKey ?? input.notificationId,
            }),
            8000,
            "notifications.submitMessage",
        );
        return result.results.some((channel) => channel.channel === "local" && channel.status === "scheduled");
    } catch (error) {
        console.warn("[runSdk] notification scheduling unavailable", error);
        return false;
    }
}

export async function cancelLocalNotification(notificationId: string): Promise<boolean> {
    if (!capabilities.notifications) return false;
    try {
        return await withTimeout(
            RundotGameAPI.notifications.cancelNotification(notificationId),
            4000,
            "notifications.cancel",
        );
    } catch (error) {
        console.warn("[runSdk] notification cancel unavailable", error);
        return false;
    }
}

export type HapticStyle = "light" | "medium" | "heavy" | "success" | "warning" | "error";

export async function triggerHaptic(style: HapticStyle): Promise<boolean> {
    // Live check, not the boot snapshot: the player can enable haptics in
    // system settings mid-session, and the cached false would eat every buzz.
    if (hapticsAvailableNow()) {
        const styleMap: Record<HapticStyle, HapticFeedbackStyle> = {
            light: HapticFeedbackStyle.Light,
            medium: HapticFeedbackStyle.Medium,
            heavy: HapticFeedbackStyle.Heavy,
            success: HapticFeedbackStyle.Success,
            warning: HapticFeedbackStyle.Warning,
            error: HapticFeedbackStyle.Error,
        };
        try {
            await withTimeout(RundotGameAPI.triggerHapticAsync(styleMap[style]), 1000, "triggerHapticAsync");
            return true;
        } catch {
            // Continue into web vibration fallback.
        }
    }
    try {
        const webNavigator = navigator as Navigator & {
            vibrate?: (pattern: number | number[]) => boolean;
        };
        if (!webNavigator.vibrate) return false;
        const patterns: Record<HapticStyle, number | number[]> = {
            light: 10,
            medium: 18,
            heavy: 36,
            success: [12, 35, 12],
            warning: [22, 36, 22],
            error: [34, 45, 34],
        };
        return webNavigator.vibrate(patterns[style]);
    } catch {
        return false;
    }
}

export function recordAnalytics(eventName: string, payload: Record<string, unknown> = {}): void {
    if (!capabilities.analytics) return;
    void RundotGameAPI.analytics.recordCustomEvent(eventName, payload).catch(() => undefined);
}

/**
 * Register an ordered funnel step. Distinct from recordAnalytics: a custom
 * event is a point in time, whereas a funnel step belongs to a named, ordered
 * sequence the dashboard can draw a drop-off curve for. Step numbers and names
 * are frozen once deployed.
 */
export function recordFunnelStep(step: number, name: string, funnel: string, funnelOrder = 0): void {
    if (!capabilities.analytics) return;
    void RundotGameAPI.analytics.trackFunnelStep(step, name, funnel, funnelOrder).catch(() => undefined);
}

export interface LifecycleConfig {
    onPause?: () => void;
    onResume?: () => void;
    onSleep?: () => void;
    onAwake?: () => void;
    onQuit?: () => void;
    onBackButton?: () => void;
}

export function registerLifecycles(config: LifecycleConfig): { unsubscribeAll(): void } {
    if (!ready) return { unsubscribeAll() {} };
    const subscriptions: Subscription[] = [];
    const add = (handler: (() => void) | undefined, register: (callback: () => void) => Subscription): void => {
        if (!handler) return;
        try {
            subscriptions.push(register(handler));
        } catch (error) {
            console.warn("[runSdk] lifecycle registration failed", error);
        }
    };
    add(config.onPause, (callback) => RundotGameAPI.lifecycles.onPause(callback));
    add(config.onResume, (callback) => RundotGameAPI.lifecycles.onResume(callback));
    add(config.onSleep, (callback) => RundotGameAPI.lifecycles.onSleep(callback));
    add(config.onAwake, (callback) => RundotGameAPI.lifecycles.onAwake(callback));
    add(config.onQuit, (callback) => RundotGameAPI.lifecycles.onQuit(callback));
    add(config.onBackButton, (callback) => RundotGameAPI.lifecycles.onBackButton(callback));
    return {
        unsubscribeAll(): void {
            for (const subscription of subscriptions) {
                try {
                    subscription.unsubscribe();
                } catch {
                    // Already detached.
                }
            }
        },
    };
}

export async function requestHostExit(): Promise<boolean> {
    if (!ready) return false;
    try {
        return await withTimeout(
            RundotGameAPI.requestPopOrQuit({ reason: "scrap-shift-root-back" }),
            4000,
            "requestPopOrQuit",
        );
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Return-reminder support. Kept beside the other notification calls so the
// retention module never talks to RundotGameAPI directly.
// ---------------------------------------------------------------------------

/** Alias matching the shared retention module's expected name. */
export async function notificationsEnabled(): Promise<boolean> {
    return localNotificationsEnabled();
}

/**
 * Cancel-then-schedule, so re-arming re-anchors the timer rather than stacking
 * a second copy of the same reminder.
 */
export async function rearmLocalNotification(input: {
    id: string;
    title: string;
    body: string;
    delaySeconds: number;
}): Promise<boolean> {
    await cancelLocalNotification(input.id);
    return scheduleLocalNotification({
        notificationId: input.id,
        title: input.title,
        body: input.body,
        delaySeconds: input.delaySeconds,
    });
}

/**
 * How this session was launched. `timed_out` is treated as unknown rather than
 * organic, so notification attribution never over-counts cold starts.
 */
export async function resolveLaunchIntent(): Promise<{ kind: string; params: Record<string, string> } | null> {
    try {
        const intent = await RundotGameAPI.app.resolveLaunchIntent({ maxWaitMs: 800 });
        if (!intent || intent.kind === "timed_out") return null;
        return { kind: intent.kind, params: intent.params ?? {} };
    } catch {
        return null;
    }
}
