/** Day-zero monetization decisions kept in typed game configuration. */

export type MonetizationModel = "none" | "ad-led" | "purchase-led" | "hybrid";
export type PurchaseArchitecture = "shop-entitlements" | "low-level-rb";

export interface MonetizationUnlockGate {
    valueMoment: string;
    minCompletedSessions?: number;
    minProgression?: number;
}

export interface MonetizationGuardrails {
    retention: string;
    sessionHealth: string;
    economyHealth: string;
    reliability: string;
}

export interface MonetizationPlan {
    version: number;
    model: MonetizationModel;
    nonPayerPromise: string;
    purchaseArchitecture: PurchaseArchitecture;
    architectureRationale: string;
    firstExposure: MonetizationUnlockGate;
    primaryKpis: string[];
    guardrails: MonetizationGuardrails;
}

export interface MonetizationPlanInput extends Omit<MonetizationPlan, "version"> {
    version?: number;
}

export function createMonetizationPlan(input: MonetizationPlanInput): Readonly<MonetizationPlan> {
    // ADAPT: complete this config from docs/monetization.md before exposing a surface.
    const plan: MonetizationPlan = {
        ...input,
        version: positiveInteger(input.version, 1),
        primaryKpis: [...input.primaryKpis],
        guardrails: { ...input.guardrails },
        firstExposure: { ...input.firstExposure },
    };

    const errors = validateMonetizationPlan(plan);
    if (errors.length > 0) throw new Error(`Invalid monetization plan: ${errors.join("; ")}`);
    return Object.freeze(plan);
}

export function validateMonetizationPlan(plan: MonetizationPlan): string[] {
    const errors: string[] = [];
    if (!plan.nonPayerPromise.trim()) errors.push("nonPayerPromise is required");
    if (!plan.firstExposure.valueMoment.trim()) errors.push("firstExposure.valueMoment is required");
    if (!plan.architectureRationale.trim()) errors.push("architectureRationale is required");
    if (plan.primaryKpis.length > 3) errors.push("use at most three primary KPIs");
    if (plan.model !== "none" && plan.primaryKpis.length === 0) {
        errors.push("a monetized model needs at least one primary KPI");
    }
    if (plan.purchaseArchitecture === "low-level-rb" && !/prototype|risk|crash/i.test(plan.architectureRationale)) {
        errors.push("low-level-rb rationale must document prototype/risk/crash-window acceptance");
    }
    return errors;
}

function positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
