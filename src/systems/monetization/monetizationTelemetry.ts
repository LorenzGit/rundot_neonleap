/** Stable, best-effort monetization events. Never use these as an ownership ledger. */

export type MonetizationEventName =
    | "store_opened"
    | "offer_shown"
    | "offer_clicked"
    | "iap_purchase_started"
    | "checkout_result"
    | "entitlement_synced"
    | "ad_requested"
    | "ad_result"
    | "reward_claimed"
    | "iap_purchase_complete"
    | "iap_purchase_failed"
    | "rewarded_ad_watched"
    | "rewarded_ad_dismissed"
    | "currency_earned"
    | "currency_spent"
    | "premium_purchased"
    | "offer_dismissed"
    | "shop_purchase"
    | "item_equipped";

export type MonetizationEventValue = string | number | boolean | null | undefined;
export type MonetizationEventPayload = Record<string, MonetizationEventValue>;

export interface MonetizationAnalyticsPort {
    recordCustomEvent(name: string, payload: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface MonetizationTelemetryConfig {
    analytics: MonetizationAnalyticsPort | null;
    context?: () => MonetizationEventPayload;
    enabled?: Partial<Record<MonetizationEventName, boolean>>;
    debug?: boolean;
}

export interface MonetizationTelemetry {
    record(name: MonetizationEventName, payload?: MonetizationEventPayload): void;
}

export function createMonetizationTelemetry(config: MonetizationTelemetryConfig): MonetizationTelemetry {
    // ADAPT: context should include game version, platform, progression, payer state, and experiment where available.
    return {
        record(name, payload = {}) {
            if (config.enabled?.[name] === false) return;
            const merged: MonetizationEventPayload = {};
            try {
                Object.assign(merged, config.context?.() ?? {});
            } catch {
                /* telemetry context is optional */
            }
            Object.assign(merged, payload);

            if (config.debug) {
                try {
                    console.debug("[monetization]", name, merged);
                } catch {
                    /* console may be absent */
                }
            }

            try {
                const result = config.analytics?.recordCustomEvent(name, merged);
                if (result && typeof (result as PromiseLike<unknown>).then === "function") {
                    void Promise.resolve(result).catch(() => {});
                }
            } catch {
                /* telemetry must never block gameplay */
            }
        },
    };
}
