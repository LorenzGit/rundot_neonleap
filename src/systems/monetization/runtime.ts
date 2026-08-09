import { fetchLiveOpsConfig, getRunCapabilities } from "../../sdk/runSdk.ts";
import {
    type MonetizationLiveOps,
    type MonetizationLiveOpsInput,
    normalizeMonetizationLiveOps,
} from "./monetizationLiveOps.ts";

export interface MonetizationRuntime {
    loaded: boolean;
    configVersion: string | null;
    controls: MonetizationLiveOps;
}

let runtime: MonetizationRuntime = {
    loaded: false,
    configVersion: null,
    controls: normalizeMonetizationLiveOps(null),
};

let retryTimer = 0;

function monetizationInput(value: unknown): MonetizationLiveOpsInput | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as MonetizationLiveOpsInput;
}

export async function refreshMonetizationRuntime(): Promise<void> {
    window.clearTimeout(retryTimer);
    retryTimer = 0;
    const config = await fetchLiveOpsConfig();
    if (!config) {
        // KEEP the live controls on a failed fetch: resetting to defaults here
        // would yank an enabled shop/ads surface for the rest of the session on
        // a single resume-time network blip. Retry only where a host could
        // actually answer — without the capability this null is permanent.
        runtime = { ...runtime, loaded: true };
        if (getRunCapabilities().liveops) {
            retryTimer = window.setTimeout(() => void refreshMonetizationRuntime(), 60_000);
        }
        return;
    }
    runtime = {
        loaded: true,
        configVersion: config.configVersion,
        controls: normalizeMonetizationLiveOps(monetizationInput(config.values.monetization)),
    };
}

export function getMonetizationRuntime(): Readonly<MonetizationRuntime> {
    return runtime;
}
