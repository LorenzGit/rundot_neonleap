// Return reminders — the "reminder" half of retention.
//
// Retention needs a REASON to come back (a goal the player is mid-way through)
// and a REMINDER that reaches them after they have left. This module owns the
// reminder; the reason lives in the game's own progression and is passed in as
// notification copy.
//
// The contract, in the order it matters:
//
//   1. Cadence 24h / 48h / 72h, then STOP. A fourth ping is noise and buys
//      opt-outs, not returns.
//   2. Every reminder names a SPECIFIC waiting thing. "Come back and play" is
//      the copy that gets muted; "your streak ends tonight" is the copy that
//      gets tapped. `ReturnReminder.body` is required for this reason.
//   3. The 24h reminder is re-anchored at the END of every session, so it
//      fires a day after the player actually last played rather than a day
//      after install.
//   4. A notification launch is resolved at startup, deep-linked, and
//      attributed — otherwise there is no way to know which copy works.
//   5. Kill switch: once the thing the reminder promised is done (reward
//      claimed, timer collected), cancel it. Nothing burns trust like a ping
//      for a reward already taken.
//
// Portable by injection: this file has no game imports. Wire `config` once per
// game (see retentionConfig.ts).

/** One scheduled nudge. `body` must name the specific thing that is waiting. */
export interface ReturnReminder {
    /** Stable short id — becomes the notification id and the analytics label. */
    id: string;
    title: string;
    /** The reason to tap. Never generic; reference the actual waiting reward. */
    body: string;
    delaySeconds: number;
}

export interface ReturnRemindersConfig {
    /**
     * Cancel-then-schedule a local notification. Returns true only when the
     * host confirms it is scheduled. Wire to the game's SDK wrapper.
     */
    schedule: (input: { id: string; title: string; body: string; delaySeconds: number }) => Promise<boolean>;
    /** Cancel a previously scheduled notification by id. */
    cancel: (id: string) => Promise<void>;
    /** Resolve how the app was launched. Returns null when not a notification. */
    resolveLaunch: () => Promise<{ kind: string; params: Record<string, string> } | null>;
    /**
     * The player's OWN opt-out, from the game's settings. Optional; omit when
     * the game has no toggle.
     *
     * This must NOT be a cached host-permission probe. Gating on one is the
     * bug this signature exists to prevent: a probe that failed, timed out, or
     * ran before the player answered the permission prompt silently suppresses
     * every reminder for the whole session, and a mid-session grant never
     * takes effect. The host already no-ops a schedule when its permission is
     * off, so an ungranted attempt is free — a stale `false` is not.
     */
    isOptedOut?: () => boolean;
    /**
     * Cached host permission, for telemetry only — it rides on the scheduled
     * event so a low `scheduled:true` rate can be told apart from a low
     * permission rate. Never gates.
     */
    permissionHint?: () => boolean;
    /** Fire-and-forget analytics. */
    track: (event: string, payload: Record<string, string | number | boolean>) => void;
    /**
     * The cadence, resolved lazily. A getter rather than an array because the
     * copy is localized: evaluating it at module load would freeze whichever
     * locale happened to be active before the save restored the player's.
     * Keep it to three entries.
     */
    reminders: () => readonly ReturnReminder[];
    /** Prefix for notification ids, unique per game. */
    idPrefix: string;
}

const HOUR = 3_600;

/** The cadence delays. Only the copy is per-game; the timing is not. */
export const RETURN_DELAYS_SECONDS = [24 * HOUR, 48 * HOUR, 72 * HOUR] as const;

export interface ReturnReminders {
    /** Schedule the whole cadence. Safe to call on every session end. */
    refreshAll(): Promise<void>;
    /**
     * Re-anchor only the 24h reminder to now. Cheaper than refreshAll and the
     * right call on a mid-session checkpoint.
     */
    refreshPrimary(): Promise<void>;
    /** Cancel one reminder once its promised task is done. */
    cancel(id: string): Promise<void>;
    /** Cancel every reminder (e.g. the player disabled notifications). */
    cancelAll(): Promise<void>;
    /**
     * Resolve a notification launch at startup. Returns the reminder id that
     * opened the app so the caller can deep-link, or null.
     */
    resolveLaunch(): Promise<string | null>;
}

export function createReturnReminders(config: ReturnRemindersConfig): ReturnReminders {
    const { schedule, cancel, resolveLaunch, isOptedOut, permissionHint, track, reminders, idPrefix } = config;
    const fullId = (id: string) => `${idPrefix}-${id}`;

    /** Only an explicit player opt-out stops a schedule. See `isOptedOut`. */
    const suppressed = () => isOptedOut?.() === true;

    async function scheduleOne(reminder: ReturnReminder): Promise<void> {
        const ok = await schedule({
            id: fullId(reminder.id),
            title: reminder.title,
            body: reminder.body,
            delaySeconds: reminder.delaySeconds,
        });
        // Scheduled-vs-opened is the only way to tell whether the copy works.
        // Recording the attempt (not just the success) also surfaces hosts that
        // silently refuse to schedule.
        track("retention_notification_scheduled", {
            reminder_id: reminder.id,
            delay_hours: Math.round(reminder.delaySeconds / HOUR),
            scheduled: ok,
            permission_cached: permissionHint?.() ?? false,
        });
    }

    return {
        async refreshAll() {
            if (suppressed()) return;
            for (const reminder of reminders()) {
                await scheduleOne(reminder);
            }
        },

        async refreshPrimary() {
            if (suppressed()) return;
            const primary = reminders()[0];
            if (primary) await scheduleOne(primary);
        },

        async cancel(id) {
            try {
                await cancel(fullId(id));
                track("retention_notification_cancelled", { reminder_id: id });
            } catch {
                // a reminder that cannot be cancelled must not break the beat
                // that completed the task it was promising
            }
        },

        async cancelAll() {
            for (const reminder of reminders()) {
                try {
                    await cancel(fullId(reminder.id));
                } catch {
                    // best effort
                }
            }
        },

        async resolveLaunch() {
            try {
                const intent = await resolveLaunch();
                if (!intent || intent.kind !== "notification") return null;
                // The id round-trips through the notification payload; fall back
                // to the notification id itself for hosts that drop params.
                const raw = intent.params.reminder_id ?? intent.params.notificationId ?? "";
                const id = raw.startsWith(`${idPrefix}-`) ? raw.slice(idPrefix.length + 1) : raw;
                if (!id) return null;
                track("retention_notification_opened", { reminder_id: id });
                return id;
            } catch {
                return null;
            }
        },
    };
}
