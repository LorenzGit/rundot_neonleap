// Funnel + custom-event analytics for RUN games.
//
// Gameplay code calls small typed helpers on the system created by
// createAnalytics(); the funnel NAMES and STEP NUMBERS live in one declaration
// (see analyticsConfig.ts) instead of being spelled out at each call site.
// That declaration is what makes a funnel *registered* rather than a loose
// stream of custom events: the dashboard can only draw a drop-off curve for
// steps it knows belong to the same funnel, in order.
//
// Two surfaces, mirroring the SDK:
//
//   1. Funnels (trackFunnelStep) — ordered drop-off arcs. A useful first-run
//      funnel is at MINIMUM three steps: loaded -> first action -> first
//      completion. A one-step funnel proves only that the app booted; it
//      cannot show onboarding drop-off, which is the whole point.
//
//   2. Custom events (recordCustomEvent) — point-in-time payloads that do not
//      fit a strict ordering: spends, failures, milestones, run summaries.
//
// Dedup model — the two kinds of funnel behave differently:
//   - Lifetime funnels (`onceEver`, e.g. 'ftue'): each step fires the first
//     time it ever happens and never again, persisted in localStorage. Without
//     this, replays and reinstalls re-fire step 1..N and the funnel reads as
//     non-monotonic garbage.
//   - Repeatable funnels (e.g. 'engagement', 'purchase'): the backend counts
//     a step as "ever reached" per session, so call sites need no guard.
//
// Emission is injected (`emitEvent` / `emitFunnelStep`) so this file stays
// identical across games while each game keeps its own SDK wrapper, capability
// gate, and payload enrichment.

/** A value allowed in a payload: flat scalars only — identifiers, not blobs. */
export type EventPropValue = string | number | boolean | null | undefined;

/** A flat custom-event payload (also what `enrich()` returns). */
export type EventProps = Record<string, EventPropValue>;

/**
 * One funnel's declaration. `steps[i]` is the event name for step i+1 (SDK
 * steps are 1-based). `order` positions the funnel chronologically in the
 * overall player journey (auth=0, ftue=1, engagement=2, purchase=3…) so
 * several funnels compare side by side on one dashboard.
 *
 * `onceEver` marks a first-run funnel: every step is deduped for the player's
 * lifetime. Set it on the FTUE funnel and nothing else.
 */
/** What ended the session — the `trigger` dimension of session_end_summary_30d. */
export type SessionEndTrigger = "quit" | "hidden" | "pagehide";

export interface FunnelDefinition {
    order?: number;
    steps: string[];
    onceEver?: boolean;
}

export interface AnalyticsConfig {
    /** Record a custom event. Wire this to the game's own SDK wrapper. */
    emitEvent: (name: string, payload: EventProps) => void;
    /**
     * Record a funnel step. Wire this to the game's own SDK wrapper. May
     * return a boolean (or promise of one) reporting delivery — `false` or a
     * rejection un-marks a once-ever step so a later beat can retry it.
     */
    emitFunnelStep: (step: number, name: string, funnel: string, order: number) => void | boolean | Promise<boolean>;
    /**
     * Funnel declarations: name -> { order, steps, onceEver }. Declare every
     * funnel here — never rename or renumber a step that has shipped, or the
     * historical curve breaks.
     */
    funnels?: Record<string, FunnelDefinition>;
    /**
     * Cohort context merged UNDER every custom-event payload (games_played,
     * level, tutorial_step — read live off the save). Runs on every emit, so
     * keep it cheap and flat; exceptions are swallowed.
     */
    enrich?: () => EventProps;
    /**
     * Per-name kill switches checked before any payload is built. Set a funnel
     * name or event name to `false` to suppress it entirely. Absent = enabled.
     */
    enabled?: Record<string, boolean>;
    /** localStorage key holding the once-ever marks. Must be unique per game. */
    marksKey?: string;
    /** Mirror every emit to console.debug — for local/mock verification. */
    debug?: boolean;
}

export interface Analytics {
    /** Emit a custom event with enrich() context merged UNDER `props`. */
    event(name: string, props?: EventProps): void;
    /**
     * Fire step `step` (1-based) of a declared funnel. Undeclared funnels and
     * out-of-range steps silently no-op. On an `onceEver` funnel the step is
     * dropped if it has ever fired before on this device.
     */
    funnelStep(funnel: string, step: number, props?: EventProps): void;
    /** True if an `onceEver` funnel step has not fired yet (for gating UI). */
    isFirstTime(funnel: string, step: number): boolean;
    /** Report a caught error as a queryable `error_occurred` event. */
    trackError(context: string, error: unknown, props?: EventProps): void;
    /** Install window error + unhandledrejection -> `error_occurred`. Once. */
    installErrorCapture(): void;
    /** Record `session_start`, enriched with landing attribution when available. */
    sessionStart(firstTimePlayer: boolean, attribution?: EventProps): void;
    /**
     * Record `session_pause` with the elapsed session time. Wire to the host's
     * sleep/pause lifecycle — the pair of pause/end events is what turns raw
     * sessions into session-length and sessions-per-day, which is how you see
     * a load regression or an over-monetized build without guessing.
     */
    sessionPause(): void;
    /**
     * Record `session_end` with elapsed time, screens viewed, the screen the
     * player was last on, and what ended the session.
     *
     * RUN's `session_end_summary_30d` groups by `screen` and `trigger`; sending
     * neither is why every row this query has ever returned reads
     * "unknown/unknown". `screen` is tracked automatically from `screen_viewed`.
     */
    sessionEnd(trigger?: SessionEndTrigger): void;
    /**
     * Wire the browser's own end-of-session signals. Call once at boot.
     *
     * `onQuit` alone is not enough: it needs a clean host-initiated quit, and
     * real players close the tab or swipe the app away instead. Across a
     * 17-game fleet that path produced two events in thirty days. The
     * `visibilitychange -> hidden` signal is the one that actually fires, and
     * it fires while the page is still alive, so the request has time to leave.
     */
    installSessionEndCapture(): void;
    /** Record `experiment_exposure`. Call right after resolving a variant. */
    experimentExposure(experiment: { name: string; variant: string; group?: string | null }): void;
    /** Clear all once-ever marks — wire to any dev "reset progress" action. */
    resetOnceEver(): void;
    /**
     * Mark the SDK ready and deliver everything recorded before it was.
     *
     * Instrumentation fired at the top of boot — the very rows that tell you
     * how many players never reach a playable frame — happens BEFORE the
     * analytics capability exists. Without a queue those emits are dropped and
     * the funnel silently begins at "successfully loaded", which is exactly the
     * blind spot that makes a load regression look like a retention problem.
     * Call once, immediately after SDK init resolves.
     */
    markTransportReady(): void;
}

const DEFAULT_MARKS_KEY = "analytics_funnel_marks";

export function createAnalytics(config: AnalyticsConfig): Analytics {
    const { emitEvent, emitFunnelStep, funnels = {}, enrich = null, enabled = {}, debug = false } = config;
    const marksKey = config.marksKey ?? DEFAULT_MARKS_KEY;

    // Once-ever marks are read once and cached: funnelStep runs on gameplay
    // paths, and a localStorage read per step would be a needless sync hit.
    let marks: Set<string> | null = null;
    let errorCaptureInstalled = false;
    // Session clock. performance.now() rather than Date.now(): it is monotonic,
    // so a device clock change mid-session cannot produce a negative duration.
    const sessionStartedAt = typeof performance !== "undefined" ? performance.now() : 0;
    let screensViewed = 0;
    /** Last screen reported via `screen_viewed`; the "where did they quit" field. */
    let lastScreen = "boot";
    let sessionEndCaptureInstalled = false;
    /**
     * A session ends once. Re-armed when the page becomes visible again, so a
     * player who backgrounds the game and returns still gets a real end event
     * for the second stretch.
     */
    let sessionEnded = false;

    function elapsedSeconds(): number {
        if (typeof performance === "undefined") return 0;
        return Math.max(0, Math.round((performance.now() - sessionStartedAt) / 1000));
    }

    // Pre-init buffer. Bounded: a boot loop that emits without ever reaching
    // markTransportReady() must not grow this without limit.
    const MAX_PENDING = 200;
    let transportReady = false;
    let pending: Array<() => void> = [];
    let droppedBeforeReady = 0;

    /** Deliver now if the transport is up, otherwise queue for markTransportReady(). */
    function deliver(send: () => void): void {
        if (transportReady) {
            send();
            return;
        }
        if (pending.length >= MAX_PENDING) {
            droppedBeforeReady += 1;
            return;
        }
        pending.push(send);
    }

    function readMarks(): Set<string> {
        if (marks) return marks;
        try {
            const raw = localStorage.getItem(marksKey);
            const parsed: unknown = raw ? JSON.parse(raw) : null;
            marks = new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
        } catch {
            marks = new Set();
        }
        return marks;
    }

    /** Returns true if `mark` was newly held in memory, false if it existed. */
    function holdMark(mark: string): boolean {
        const current = readMarks();
        if (current.has(mark)) return false;
        current.add(mark);
        return true;
    }

    function persistMarks(): void {
        try {
            localStorage.setItem(marksKey, JSON.stringify([...readMarks()]));
        } catch {
            // quota / private mode: the in-memory set still dedups this session
        }
    }

    /** Undo a held mark after a failed delivery so a later beat can retry. */
    function releaseMark(mark: string): void {
        readMarks().delete(mark);
    }

    function isOff(name: string): boolean {
        return enabled[name] === false;
    }

    function log(kind: string, ...args: unknown[]): void {
        if (!debug) return;
        try {
            console.debug("[analytics]", kind, ...args);
        } catch {
            // consoleless environment
        }
    }

    function safeEmitEvent(name: string, payload: EventProps): void {
        deliver(() => {
            try {
                emitEvent(name, payload);
            } catch {
                // Telemetry is observational and must never alter gameplay.
            }
        });
    }

    const system: Analytics = {
        event(name, props) {
            if (isOff(name)) return;
            const payload: EventProps = {};
            if (enrich) {
                try {
                    Object.assign(payload, enrich() ?? {});
                } catch {
                    // enrich must never block the event it decorates
                }
            }
            if (props) Object.assign(payload, props);
            if (name === "screen_viewed") {
                screensViewed += 1;
                const screen = payload.screen;
                if (typeof screen === "string" && screen) lastScreen = screen;
            }
            log("event", name, payload);
            safeEmitEvent(name, payload);
        },

        funnelStep(funnel, step, props) {
            if (isOff(funnel)) return;
            const definition = funnels[funnel];
            const name = definition?.steps[step - 1];
            if (!name) return;
            const onceMark = definition.onceEver ? `${funnel}:${step}:${name}` : null;
            if (onceMark && !holdMark(onceMark)) return;
            log("funnel", funnel, step, name);
            const order = definition.order ?? 0;
            deliver(() => {
                try {
                    const result = emitFunnelStep(step, name, funnel, order);
                    if (!onceMark) return;
                    void Promise.resolve(result)
                        .then((ok) => {
                            if (ok === false) releaseMark(onceMark);
                            else persistMarks();
                        })
                        .catch(() => releaseMark(onceMark));
                } catch {
                    // never let a funnel step break the beat that triggered it
                    if (onceMark) releaseMark(onceMark);
                }
            });
            // trackFunnelStep carries no payload, so context rides on a
            // parallel custom event named after the step.
            if (props) system.event(name, { funnel, funnel_step: step, ...props });
        },

        isFirstTime(funnel, step) {
            const definition = funnels[funnel];
            const name = definition?.steps[step - 1];
            if (!name || !definition?.onceEver) return true;
            return !readMarks().has(`${funnel}:${step}:${name}`);
        },

        trackError(context, error, props) {
            const message = error instanceof Error ? error.message : String(error);
            system.event("error_occurred", { type: context, message: message.slice(0, 200), ...props });
        },

        installErrorCapture() {
            if (errorCaptureInstalled || typeof window === "undefined") return;
            errorCaptureInstalled = true;
            window.addEventListener("error", (event) => {
                system.event("error_occurred", {
                    type: "window_error",
                    message: String(event.message).slice(0, 200),
                    source: event.filename ?? "",
                    line: event.lineno ?? 0,
                });
            });
            window.addEventListener("unhandledrejection", (event) => {
                const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
                system.event("error_occurred", { type: "unhandled_rejection", message: reason.slice(0, 200) });
            });
        },

        sessionStart(firstTimePlayer, attribution) {
            system.event("session_start", { first_time_player: firstTimePlayer, ...attribution });
        },

        sessionPause() {
            system.event("session_pause", { elapsed_sec: elapsedSeconds() });
        },

        sessionEnd(trigger = "quit") {
            if (sessionEnded) return;
            sessionEnded = true;
            system.event("session_end", {
                elapsed_sec: elapsedSeconds(),
                screens_viewed: screensViewed,
                screen: lastScreen,
                trigger,
            });
        },

        installSessionEndCapture() {
            if (sessionEndCaptureInstalled || typeof document === "undefined") return;
            sessionEndCaptureInstalled = true;
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "hidden") this.sessionEnd("hidden");
                else sessionEnded = false;
            });
            // Backstop for browsers that tear down without a hidden transition.
            window.addEventListener("pagehide", () => this.sessionEnd("pagehide"));
        },

        experimentExposure(experiment) {
            system.event("experiment_exposure", {
                experiment: experiment.name,
                variant: experiment.variant,
                group: experiment.group ?? "unassigned",
            });
        },

        resetOnceEver() {
            marks = new Set();
            try {
                localStorage.removeItem(marksKey);
            } catch {
                // ignore
            }
        },

        markTransportReady() {
            if (transportReady) return;
            transportReady = true;
            const queued = pending;
            pending = [];
            for (const send of queued) send();
            if (droppedBeforeReady > 0) {
                // Surface the loss rather than hiding it: a non-zero count here
                // means boot emitted more than MAX_PENDING before the SDK came
                // up, which is itself a boot problem worth seeing.
                system.event("analytics_pending_overflow", { dropped: droppedBeforeReady });
                droppedBeforeReady = 0;
            }
        },
    };

    return system;
}

/**
 * Build the step-name array for a "counted" funnel — one step per integer
 * value of a progression counter:
 *
 *   countedSteps('level_completed_', 12)
 *   // -> ['level_completed_1', ..., 'level_completed_12']
 *
 * Fire funnelStep('engagement', newTotal) after each increment and the funnel
 * plots retention across the first `count` values; counts past the end no-op
 * via the out-of-range rule.
 */
export function countedSteps(prefix: string, count: number): string[] {
    const steps: string[] = [];
    for (let index = 1; index <= count; index += 1) steps.push(`${prefix}${index}`);
    return steps;
}
