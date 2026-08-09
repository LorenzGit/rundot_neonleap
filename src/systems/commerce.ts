import type { ShopOrderHistoryResponse, ShopPurchaseResponse, StorefrontItem } from "@series-inc/rundot-game-sdk";
import {
    fetchEntitlements,
    fetchShopCatalog,
    fetchShopOrderHistory,
    getRunCapabilities,
    purchaseShopItem,
    recordAnalytics,
} from "../sdk/runSdk.ts";
import { analytics } from "./analytics/analyticsConfig.ts";
import { checkoutErrorCode, verdictForCode, verdictForMessage } from "./monetization/checkoutClassification.ts";
import { cellsForCatalogItem, monetizationProducts, NEON_CORE_ENTITLEMENT_ID } from "./monetization/config.ts";
import {
    createPurchaseCoordinator,
    type PendingPurchaseIntent,
    type PurchaseOutcome,
} from "./monetization/purchaseCoordinator.ts";
import { getMonetizationRuntime } from "./monetization/runtime.ts";
import { saveSystem } from "./save.ts";

export type CommerceProductId = "neon_core" | "cell_cache";

export interface ProductCommerceView {
    productId: CommerceProductId;
    visible: boolean;
    owned: boolean;
    entitlementVerified: boolean;
    purchasable: boolean;
    priceLabel: string;
    statusLabel: string;
    name: string;
}

let catalog = new Map<string, StorefrontItem>();
let catalogConfigId: string | null = null;
let entitlementIds = new Set<string>();
let authoritativeEntitlementsLoaded = false;
let refreshInFlight: Promise<void> | null = null;

/**
 * Launch price hypotheses (DESIGN.md §11). Only shown as a local development
 * preview; the live price always comes from the RUN catalog.
 */
const DEV_PREVIEW_PRICES: Readonly<Record<CommerceProductId, string>> = {
    neon_core: "249 RB",
    cell_cache: "120 RB",
};

export function isCellCache(productId: CommerceProductId): boolean {
    return productId === "cell_cache";
}

async function syncEntitlements(): Promise<void> {
    const entitlements = await fetchEntitlements();
    if (entitlements === null) {
        authoritativeEntitlementsLoaded = false;
        entitlementIds = new Set();
        return;
    }
    authoritativeEntitlementsLoaded = true;
    entitlementIds = new Set(
        entitlements
            .filter((entry) => entry.status === "active" && entry.quantity > 0)
            .map((entry) => entry.entitlementId),
    );
    // Mirror the host's NEON CORE verdict locally so the +25% cell bonus and
    // ad removal survive offline boots — the ledger stays authoritative.
    saveSystem.setNeonCoreEntitlement(entitlementIds.has(NEON_CORE_ENTITLEMENT_ID));
}

function liveProduct(productId: string): StorefrontItem | null {
    const definition = monetizationProducts.get(productId);
    return definition ? (catalog.get(definition.catalogItemId) ?? null) : null;
}

function formatLivePrice(item: StorefrontItem): string {
    const price = item.resolvedPrice.finalPrice;
    const unit = price.type.toLowerCase() === "bucks" ? "RB" : price.type.toUpperCase();
    return `${price.value} ${unit}`.trim();
}

function productIsEligible(): boolean {
    // Both products unlock after the first completed run (§11's value moment).
    return saveSystem.get().records.totalRuns >= 1;
}

/**
 * Turns every fulfilled, not-yet-redeemed CELL CACHE order into cells. The
 * order id is the idempotency key, so replaying history can never
 * double-grant, and a purchase interrupted mid-checkout is still honoured on
 * the next boot.
 */
export async function redeemPurchasedCells(): Promise<number> {
    const capabilities = getRunCapabilities();
    if (!capabilities.shop || capabilities.mock) return 0;
    let history: Awaited<ReturnType<typeof fetchShopOrderHistory>>;
    try {
        history = await fetchShopOrderHistory();
    } catch (error) {
        console.warn("[commerce] cell redemption deferred; order history unavailable", error);
        return 0;
    }
    if (!history.success) return 0;
    let granted = 0;
    for (const order of history.orders) {
        if (order.status !== "fulfilled") continue;
        const cells = cellsForCatalogItem(order.itemId);
        if (cells <= 0) continue;
        if (saveSystem.redeemCellOrder(order.orderId, cells)) {
            granted += cells;
            recordAnalytics("cell_cache_redeemed", { itemId: order.itemId, orderId: order.orderId, cells });
        }
    }
    if (granted > 0) await saveSystem.flush();
    return granted;
}

/** The host accepted the order but has not settled it — outcome still open. */
class UnsettledOrderError extends Error {
    constructor(status: string | undefined) {
        super(`RUN shop returned order status "${status ?? "none"}"`);
    }
}

const purchaseCoordinator = createPurchaseCoordinator<ShopPurchaseResponse, ShopOrderHistoryResponse>({
    shop: {
        async purchase(itemId, idempotencyKey) {
            const response = await purchaseShopItem(itemId, idempotencyKey);
            // `success` only reports that the host accepted the request.
            // Replaying an idempotency key returns the ORIGINAL order verbatim,
            // so an order still in `pending_payment` also arrives as
            // `success: true` — paying out on that would grant an unpaid
            // purchase, and the player may still have been charged, so it has
            // to stay unresolved rather than be written off.
            if (!response.success || response.order?.status !== "fulfilled") {
                throw new UnsettledOrderError(response.order?.status);
            }
            return response;
        },
        getOrderHistory: fetchShopOrderHistory,
    },
    pending: {
        load: () => saveSystem.get().monetization.pendingPurchaseIntent,
        async save(intent) {
            saveSystem.setPendingPurchaseIntent(intent);
            if (!(await saveSystem.flush())) throw new Error("PURCHASE INTENT COULD NOT BE SAVED");
        },
        async clear() {
            saveSystem.setPendingPurchaseIntent(null);
            await saveSystem.flush();
        },
    },
    findConfirmedOrder(history, intent) {
        if (!history.success) return null;
        return (
            history.orders.find(
                (order) =>
                    order.itemId === intent.catalogItemId &&
                    order.idempotencyKey === intent.idempotencyKey &&
                    order.status === "fulfilled",
            ) ?? null
        );
    },
    syncEntitlements,
    classifyError(error) {
        // An order the host never settled may already have taken the money.
        if (error instanceof UnsettledOrderError) return "unknown";
        // The host names most declines outright; that code is the only reliable
        // way to tell a clean, uncharged refusal from an ambiguous failure.
        const code = checkoutErrorCode(error);
        if (code) {
            const verdict = verdictForCode(code);
            if (verdict !== "unknown") return verdict;
        }
        // Otherwise fall back to the host's human-readable message.
        return verdictForMessage(error instanceof Error ? error.message : String(error));
    },
});

export async function refreshCommerce(): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
        const [nextCatalog] = await Promise.all([fetchShopCatalog(), syncEntitlements()]);
        catalogConfigId = nextCatalog?.configId ?? null;
        catalog = new Map((nextCatalog?.items ?? []).filter((item) => item.active).map((item) => [item.itemId, item]));
    })().finally(() => {
        refreshInFlight = null;
    });
    return refreshInFlight;
}

export function commerceEntitlementsReady(): boolean {
    return authoritativeEntitlementsLoaded;
}

export function hasVerifiedEntitlement(entitlementId: string): boolean {
    return authoritativeEntitlementsLoaded && entitlementIds.has(entitlementId);
}

/** True when the host has verified NEON CORE (ad removal + cell bonus). */
export function neonCoreOwned(): boolean {
    if (hasVerifiedEntitlement(NEON_CORE_ENTITLEMENT_ID)) return true;
    // Between boots the local mirror answers; the next sync corrects it.
    return !authoritativeEntitlementsLoaded && saveSystem.get().entitlements.neonCore;
}

export function productCommerceView(productId: CommerceProductId): ProductCommerceView {
    const definition = monetizationProducts.get(productId);
    if (!definition) throw new Error(`Missing commerce product ${productId}`);
    const item = liveProduct(productId);
    const capabilities = getRunCapabilities();
    const runtime = getMonetizationRuntime();
    const productEnabled = runtime.controls.products[productId]?.enabled === true;
    const controlsEnabled = runtime.controls.enabled && runtime.controls.purchasesEnabled && productEnabled;
    const hostReady = controlsEnabled && capabilities.shop && !capabilities.mock && item !== null;
    const devPreview = import.meta.env.DEV && (!capabilities.host || capabilities.mock);
    const eligible = productIsEligible();
    // Ownership is only meaningful for something you can own once. A consumable
    // is always buyable again, and its entitlement list is empty — and an empty
    // list satisfies `every()` vacuously, which is what silently marked every
    // consumable OWNED in the scaffold and made it impossible to buy.
    const owned =
        definition.kind !== "consumable" &&
        definition.expectedEntitlementIds.length > 0 &&
        authoritativeEntitlementsLoaded &&
        definition.expectedEntitlementIds.every((entitlementId) => entitlementIds.has(entitlementId));
    return {
        productId,
        visible: owned || eligible,
        owned,
        entitlementVerified: authoritativeEntitlementsLoaded,
        purchasable: eligible && !owned && hostReady,
        priceLabel:
            item && eligible
                ? formatLivePrice(item)
                : eligible && devPreview
                  ? DEV_PREVIEW_PRICES[productId]
                  : eligible
                    ? "PRICE SYNC REQUIRED"
                    : "UNLOCKS AFTER 1 RUN",
        statusLabel: owned
            ? "OWNED"
            : !eligible
              ? "FINISH 1 RUN"
              : devPreview
                ? `${DEV_PREVIEW_PRICES[productId]} · PREVIEW`
                : hostReady
                  ? definition.kind === "consumable"
                      ? formatLivePrice(item)
                      : "PERMANENT UNLOCK"
                  : "SYNCING OFFER",
        name: item?.name ?? (productId === "neon_core" ? "NEON CORE" : "CELL CACHE"),
    };
}

export interface CommerceDiagnostics {
    catalogConfigId: string | null;
    catalogItems: readonly {
        itemId: string;
        name: string;
        price: string;
    }[];
    entitlementIds: readonly string[];
    purchaseReady: boolean;
    testProductId: string;
    testProductName: string;
    testProductPrice: string;
    testProductOwned: boolean;
}

export function commerceDiagnostics(): CommerceDiagnostics {
    const testProductId = "neon_core";
    const definition = monetizationProducts.get(testProductId);
    if (!definition) throw new Error(`Missing diagnostic product ${testProductId}`);
    const item = liveProduct(testProductId);
    const runtime = getMonetizationRuntime();
    const capabilities = getRunCapabilities();
    const productEnabled = runtime.controls.products[testProductId]?.enabled === true;
    return {
        catalogConfigId,
        catalogItems: [...catalog.values()].map((entry) => ({
            itemId: entry.itemId,
            name: entry.name,
            price: formatLivePrice(entry),
        })),
        entitlementIds: [...entitlementIds].sort(),
        purchaseReady:
            runtime.controls.privateTestMode &&
            runtime.controls.enabled &&
            runtime.controls.purchasesEnabled &&
            productEnabled &&
            capabilities.host &&
            !capabilities.mock &&
            capabilities.shop &&
            item !== null,
        testProductId,
        testProductName: item?.name ?? definition.catalogItemId,
        testProductPrice: item ? formatLivePrice(item) : "NO LIVE PRICE",
        testProductOwned: entitlementIds.has(NEON_CORE_ENTITLEMENT_ID),
    };
}

export async function purchaseProduct(
    productId: CommerceProductId,
    placement = "supply_shop",
): Promise<PurchaseOutcome<ShopPurchaseResponse> | null> {
    const definition = monetizationProducts.get(productId);
    const item = definition ? liveProduct(productId) : null;
    const runtime = getMonetizationRuntime();
    const enabled =
        runtime.controls.enabled &&
        runtime.controls.purchasesEnabled &&
        runtime.controls.products[productId]?.enabled === true;
    if (!enabled || !definition || !item || !getRunCapabilities().shop || getRunCapabilities().mock) return null;
    analytics.funnelStep("purchase", 3);
    recordAnalytics("checkout_started", { productId, placement });
    const outcome = await purchaseCoordinator.purchase(productId, definition.catalogItemId);
    analytics.funnelStep("purchase", 4);
    recordAnalytics("checkout_result", { productId, placement, result: outcome.status });
    if (isCellCache(productId)) await redeemPurchasedCells();
    return outcome;
}

export async function reconcilePendingPurchase(): Promise<void> {
    // Cells are redeemed from order history on every boot, intent or not.
    await redeemPurchasedCells();
    const pending: PendingPurchaseIntent | null = purchaseCoordinator.pendingIntent();
    if (!pending) return;
    const outcome = await purchaseCoordinator.reconcilePending();
    if (outcome) {
        recordAnalytics("checkout_result", {
            productId: pending.productId,
            placement: "resume_reconciliation",
            result: outcome.status,
        });
    }
}
