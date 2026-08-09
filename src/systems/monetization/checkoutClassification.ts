/**
 * How a failed RUN checkout should be treated, decided from the host's own
 * machine-readable error code.
 *
 * This is the difference between a shop that recovers and one that wedges. A
 * classifier that cannot name a clean decline has to call everything "unknown",
 * which parks a pending intent the player can never clear — so the code table
 * below is the load-bearing part, and it is kept free of SDK and store imports
 * so it can be exercised directly by tests.
 */

export type CheckoutVerdict = "cancelled" | "failed" | "unknown";

/**
 * Terminal AND uncharged: the order never reached the wallet, so there is
 * nothing to reconcile and the intent must be released at once.
 *
 * Both spellings of each code are listed deliberately. The H5 bridge forwards
 * its own snake_case codes for the cases it intercepts (the Run Bits top-up
 * sheet, a moved catalog) while the shop service emits kebab-case, and a
 * missed spelling degrades silently back into a stuck order.
 */
const CLEAN_DECLINE_CODES: ReadonlySet<string> = new Set([
    "insufficient_funds",
    "insufficient-funds",
    "stale_catalog",
    "stale-catalog",
    "already-owned",
    "item-not-available",
    "velocity-limit",
    "validation-error",
    "not-found",
    "config-not-found",
    "collection-not-found",
    "authorization",
    "unauthenticated",
]);

/** The player themselves backed out — clean, uncharged, and not an error. */
const CANCELLED_CODES: ReadonlySet<string> = new Set(["USER_CANCELLED", "user_cancelled", "cancelled"]);

/**
 * Codes that are explicitly NOT clean: the wallet may already have been
 * touched, so the intent must survive and be settled against order history.
 * Listed for the reader's benefit — they fall through to "unknown" anyway.
 */
const AMBIGUOUS_CODES: ReadonlySet<string> = new Set(["order-in-progress", "internal", "RATE_LIMITED"]);

export function verdictForCode(code: string): CheckoutVerdict {
    if (CANCELLED_CODES.has(code)) return "cancelled";
    if (AMBIGUOUS_CODES.has(code)) return "unknown";
    return CLEAN_DECLINE_CODES.has(code) ? "failed" : "unknown";
}

/**
 * Fallback for a host that answered without a machine code. Matching on
 * human-readable text is fragile, so it only ever promotes a case that would
 * otherwise be "unknown" — it can never overrule a code.
 */
export function verdictForMessage(message: string): CheckoutVerdict {
    const text = message.toLowerCase();
    if (text.includes("cancel")) return "cancelled";
    if (
        text.includes("insufficient") ||
        text.includes("declin") ||
        text.includes("unavailable") ||
        text.includes("not available") ||
        // The SDK's mock shop rejects an unknown catalog item with exactly this
        // phrasing and a placeholder code, so text is the only signal available.
        text.includes("not found")
    ) {
        return "failed";
    }
    return "unknown";
}

/**
 * The host's machine-readable error code, or null when it did not send one.
 *
 * A structured rejection arrives as a `RundotApiError`, which carries `code`;
 * a transport failure or timeout does not. Duck-typed rather than `instanceof`
 * because that class lives on the SDK package root while game code talks to
 * `/api` — importing it as a value would pull the root bundle in at runtime.
 * "UNKNOWN" is the RPC layer's placeholder for an envelope that carried no
 * code, so it says nothing and is reported as absent.
 */
export function checkoutErrorCode(error: unknown): string | null {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && code !== "" && code !== "UNKNOWN" ? code : null;
}

/** Player-facing reason for a decline, or null when the host did not give one. */
export type DeclineReason = "insufficient_funds" | "already_owned" | "rate_limited";

export function declineReasonForCode(code: string): DeclineReason | null {
    if (code === "insufficient_funds" || code === "insufficient-funds") return "insufficient_funds";
    if (code === "already-owned") return "already_owned";
    if (code === "velocity-limit") return "rate_limited";
    return null;
}
