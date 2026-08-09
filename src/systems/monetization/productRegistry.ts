/** Expected Shop products and entitlement contracts; prices stay server-side. */

export type ProductKind = "durable" | "consumable" | "bundle" | "subscription";

export interface ProductDefinition {
    id: string;
    catalogItemId: string;
    kind: ProductKind;
    expectedEntitlementIds: string[];
    unique: boolean;
    unlockDescription: string;
}

export interface CatalogItemSnapshot {
    id: string;
    active?: boolean;
    price?: unknown;
    entitlements?: Array<{ id?: string; entitlementId?: string }>;
}

export interface CatalogValidationIssue {
    productId: string;
    severity: "error" | "warning";
    message: string;
}

export interface ProductRegistry {
    all(): readonly Readonly<ProductDefinition>[];
    get(id: string): Readonly<ProductDefinition> | undefined;
    byCatalogItemId(catalogItemId: string): Readonly<ProductDefinition> | undefined;
    validateCatalog(items: readonly CatalogItemSnapshot[]): CatalogValidationIssue[];
}

export function createProductRegistry(definitions: readonly ProductDefinition[]): ProductRegistry {
    // ADAPT: IDs must match the live server catalog and entitlement configuration.
    const byId = new Map<string, Readonly<ProductDefinition>>();
    const byCatalogId = new Map<string, Readonly<ProductDefinition>>();

    for (const input of definitions) {
        if (!/^[a-z][a-z0-9_]*$/.test(input.id)) throw new Error(`Invalid product id: ${input.id}`);
        if (!input.catalogItemId.trim()) throw new Error(`${input.id} needs catalogItemId`);
        if (!input.unlockDescription.trim()) throw new Error(`${input.id} needs unlockDescription`);
        if (byId.has(input.id)) throw new Error(`Duplicate product id: ${input.id}`);
        if (byCatalogId.has(input.catalogItemId)) {
            throw new Error(`Duplicate catalog item id: ${input.catalogItemId}`);
        }
        const value = Object.freeze({
            ...input,
            expectedEntitlementIds: [...new Set(input.expectedEntitlementIds)],
        });
        byId.set(value.id, value);
        byCatalogId.set(value.catalogItemId, value);
    }

    return {
        all: () => Object.freeze([...byId.values()]),
        get: (id) => byId.get(id),
        byCatalogItemId: (catalogItemId) => byCatalogId.get(catalogItemId),
        validateCatalog(items) {
            const live = new Map(items.map((item) => [item.id, item]));
            const issues: CatalogValidationIssue[] = [];
            for (const expected of byId.values()) {
                const item = live.get(expected.catalogItemId);
                if (!item) {
                    issues.push({ productId: expected.id, severity: "error", message: "missing from live catalog" });
                    continue;
                }
                if (item.active === false) {
                    issues.push({ productId: expected.id, severity: "warning", message: "catalog item is inactive" });
                }
                if (item.price == null) {
                    issues.push({ productId: expected.id, severity: "error", message: "live price is missing" });
                }
                const liveEntitlements = new Set(
                    (item.entitlements ?? []).flatMap((e) => [e.id, e.entitlementId]).filter(isString),
                );
                for (const entitlementId of expected.expectedEntitlementIds) {
                    if (!liveEntitlements.has(entitlementId)) {
                        issues.push({
                            productId: expected.id,
                            severity: "error",
                            message: `missing expected entitlement ${entitlementId}`,
                        });
                    }
                }
            }
            return issues;
        },
    };
}

function isString(value: string | undefined): value is string {
    return typeof value === "string" && value.length > 0;
}
