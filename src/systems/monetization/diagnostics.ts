import { getRunCapabilities } from "../../sdk/runSdk.ts";
import { commerceDiagnostics } from "../commerce.ts";
import { interstitialAdDiagnostics } from "../interstitialAds.ts";
import { rewardedAdDiagnostics } from "../rewardedAds.ts";
import { getMonetizationRuntime } from "./runtime.ts";

export interface MonetizationDiagnosticsView {
    enabled: boolean;
    environment: string;
    configVersion: string;
    hostReady: boolean;
    liveOpsReady: boolean;
    shopReady: boolean;
    entitlementsReady: boolean;
    adsReady: boolean;
    adFillReady: boolean;
    interstitialFillReady: boolean;
    catalogConfigId: string;
    catalogItemCount: number;
    entitlementCount: number;
    purchaseReady: boolean;
    testProductId: string;
    testProductName: string;
    testProductPrice: string;
    testProductOwned: boolean;
    adTestReady: boolean;
    interstitialTestReady: boolean;
}

export function monetizationDiagnosticsView(): MonetizationDiagnosticsView {
    const capabilities = getRunCapabilities();
    const runtime = getMonetizationRuntime();
    const commerce = commerceDiagnostics();
    const ads = rewardedAdDiagnostics();
    const interstitial = interstitialAdDiagnostics();
    const environment = capabilities.mock ? "LOCAL MOCK" : capabilities.host ? "RUN HOST" : "NO HOST";
    return {
        enabled: runtime.controls.privateTestMode,
        environment,
        configVersion: runtime.configVersion ?? "NONE",
        hostReady: capabilities.host && !capabilities.mock,
        liveOpsReady: capabilities.liveops && runtime.loaded && runtime.controls.enabled,
        shopReady: capabilities.shop && commerce.catalogConfigId !== null,
        entitlementsReady: capabilities.entitlements,
        adsReady: capabilities.ads,
        adFillReady: ads.ready,
        interstitialFillReady: interstitial.ready,
        catalogConfigId: commerce.catalogConfigId ?? "NONE",
        catalogItemCount: commerce.catalogItems.length,
        entitlementCount: commerce.entitlementIds.length,
        purchaseReady: commerce.purchaseReady,
        testProductId: commerce.testProductId,
        testProductName: commerce.testProductName,
        testProductPrice: commerce.testProductPrice,
        testProductOwned: commerce.testProductOwned,
        adTestReady: ads.testReady,
        interstitialTestReady: interstitial.testReady,
    };
}
