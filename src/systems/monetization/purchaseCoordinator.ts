/** Shop purchase intents with stable idempotency keys and resume reconciliation. */

export interface PendingPurchaseIntent {
    intentId: string;
    productId: string;
    catalogItemId: string;
    idempotencyKey: string;
    createdAtMs: number;
}

export interface PendingPurchaseStore {
    load(): PendingPurchaseIntent | null;
    save(intent: PendingPurchaseIntent): void | Promise<void>;
    clear(): void | Promise<void>;
}

export interface ShopPort<PurchaseResponse = unknown, OrderHistory = unknown> {
    purchase(itemId: string, idempotencyKey: string): Promise<PurchaseResponse>;
    getOrderHistory(options?: unknown): Promise<OrderHistory>;
}

export interface PurchaseCoordinatorConfig<PurchaseResponse, OrderHistory> {
    shop: ShopPort<PurchaseResponse, OrderHistory>;
    pending: PendingPurchaseStore;
    findConfirmedOrder(history: OrderHistory, intent: PendingPurchaseIntent): unknown | null;
    syncEntitlements(): Promise<void>;
    classifyError?(error: unknown): "cancelled" | "failed" | "unknown";
    createId?: () => string;
    now?: () => number;
    /** See DEFAULT_INTENT_TTL_MS. */
    intentTtlMs?: number;
}

/**
 * How long an unresolved intent may keep blocking checkout before it is
 * abandoned. Orders settle inside a single server transaction, so one that
 * order history still does not report as fulfilled after this long is dead —
 * and an intent that outlives its order locks the player out of the whole shop.
 */
const DEFAULT_INTENT_TTL_MS = 15 * 60_000;

export type PurchaseOutcome<PurchaseResponse = unknown> =
    | { status: "confirmed"; intent: PendingPurchaseIntent; response?: PurchaseResponse; reconciledOrder?: unknown }
    | { status: "cancelled" | "failed"; intent: PendingPurchaseIntent; error: unknown }
    | { status: "unknown"; intent: PendingPurchaseIntent; error: unknown };

export interface PurchaseCoordinator<PurchaseResponse = unknown> {
    purchase(productId: string, catalogItemId: string): Promise<PurchaseOutcome<PurchaseResponse>>;
    reconcilePending(): Promise<PurchaseOutcome<PurchaseResponse> | null>;
    pendingIntent(): PendingPurchaseIntent | null;
}

export function createPurchaseCoordinator<PurchaseResponse = unknown, OrderHistory = unknown>(
    config: PurchaseCoordinatorConfig<PurchaseResponse, OrderHistory>,
): PurchaseCoordinator<PurchaseResponse> {
    const createId = config.createId ?? defaultId;
    const now = config.now ?? Date.now;
    const intentTtlMs = config.intentTtlMs ?? DEFAULT_INTENT_TTL_MS;
    let inFlight: Promise<PurchaseOutcome<PurchaseResponse>> | null = null;

    async function confirm(
        intent: PendingPurchaseIntent,
        response?: PurchaseResponse,
        order?: unknown,
    ): Promise<PurchaseOutcome<PurchaseResponse>> {
        await config.syncEntitlements();
        await config.pending.clear();
        const outcome: PurchaseOutcome<PurchaseResponse> = { status: "confirmed", intent };
        if (response !== undefined) outcome.response = response;
        if (order !== undefined) outcome.reconciledOrder = order;
        return outcome;
    }

    async function reconcile(
        intent: PendingPurchaseIntent,
        cause: unknown,
        /** Only a player-initiated purchase may retire a stale intent. */
        mayExpire = false,
    ): Promise<PurchaseOutcome<PurchaseResponse>> {
        try {
            const history = await config.shop.getOrderHistory();
            const order = config.findConfirmedOrder(history, intent);
            if (order) return confirm(intent, undefined, order);
            // The read SUCCEEDED and this intent is not in it as a fulfilled
            // order — so it is missing, not merely unreadable. Past the TTL
            // there is nothing left to wait for, and keeping it would block
            // every future checkout, so give up on it deliberately. Gated on
            // mayExpire: a passive resume check must stay read-only.
            if (mayExpire && now() - intent.createdAtMs >= intentTtlMs) {
                await config.pending.clear();
                return { status: "failed", intent, error: cause };
            }
        } catch {
            /* preserve the pending intent for the next safe resume */
        }
        return { status: "unknown", intent, error: cause };
    }

    async function handleFailure(
        intent: PendingPurchaseIntent,
        error: unknown,
    ): Promise<PurchaseOutcome<PurchaseResponse>> {
        const status = config.classifyError?.(error) ?? "unknown";
        if (status === "unknown") return reconcile(intent, error);
        await config.pending.clear();
        return { status, intent, error };
    }

    async function attempt(intent: PendingPurchaseIntent): Promise<PurchaseOutcome<PurchaseResponse>> {
        try {
            const response = await config.shop.purchase(intent.catalogItemId, intent.idempotencyKey);
            return await confirm(intent, response);
        } catch (error) {
            return handleFailure(intent, error);
        }
    }

    async function runNew(productId: string, catalogItemId: string): Promise<PurchaseOutcome<PurchaseResponse>> {
        const existing = config.pending.load();
        if (existing) {
            const reconciled = await reconcile(existing, new Error("A purchase outcome is still pending"), true);
            if (reconciled.status === "confirmed") return reconciled;
            if (existing.productId === productId && existing.catalogItemId === catalogItemId) {
                // This is a new explicit player tap for the same logical order.
                // Retrying its idempotency key cannot create a duplicate charge,
                // so re-persist the intent if reconcile just expired it out.
                if (!config.pending.load()) await config.pending.save(existing);
                return attempt(existing);
            }
            // A leftover intent for a DIFFERENT product must not swallow this
            // tap — that is what turns one failed order into a shop-wide
            // lockout. Report it only while it is still live; once reconcile
            // has cleared it, fall through and open the new checkout.
            if (config.pending.load()) return reconciled;
        }

        // ADAPT: persist this slice in the host save before opening checkout.
        const intentId = createId();
        const intent: PendingPurchaseIntent = {
            intentId,
            productId,
            catalogItemId,
            idempotencyKey: `run-game:${productId}:${intentId}`,
            createdAtMs: now(),
        };
        await config.pending.save(intent);
        return attempt(intent);
    }

    return {
        purchase(productId, catalogItemId) {
            if (!inFlight)
                inFlight = runNew(productId, catalogItemId).finally(() => {
                    inFlight = null;
                });
            return inFlight;
        },
        async reconcilePending() {
            const intent = config.pending.load();
            return intent ? reconcile(intent, new Error("Pending purchase requires reconciliation")) : null;
        },
        pendingIntent: () => config.pending.load(),
    };
}

/**
 * Idempotency keys are security identifiers, not gameplay randomness, so they
 * come from Web Crypto — never from the game's seeded `NoiseRandom`, which is
 * deterministic by design and would happily reuse a key.
 */
function defaultId(): string {
    try {
        if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    } catch {
        /* local fallback below */
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
