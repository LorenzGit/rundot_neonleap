import { analytics } from "../analytics/analyticsConfig";
import {
    cancelLocalNotification,
    notificationsEnabled,
    rearmLocalNotification,
    resolveLaunchIntent,
} from "../../sdk/runSdk";
import { RETURN_DELAYS_SECONDS, createReturnReminders } from "./returnReminders";

/**
 * Return reminders for NEONLEAP.
 *
 * Before this, the game had no way to reach a player once they closed it —
 * onboarding could convert perfectly and still produce no second session.
 *
 * The copy below is the actual product. Each body names the specific thing
 * waiting for this player; a generic "come back and play" is the wording that
 * gets muted, and muting is permanent. The cadence stops at 72h because a
 * fourth ping converts nobody and costs the permission the first three need.
 */

// Permission is read once at startup rather than per-schedule: the check is an
// async host round-trip and scheduling happens on the session-end path.
let notificationsGranted = false;

/** Refresh the cached permission. Call at startup and after any consent change. */
export async function refreshNotificationPermission(): Promise<boolean> {
    notificationsGranted = await notificationsEnabled();
    return notificationsGranted;
}

export const returnReminders = createReturnReminders({
    idPrefix: "neonleap",
    reminders: () => [
        {
            id: "d1",
            title: "Your nightly supply drop is ready",
            body: "Collect your cells and take one more run.",
            delaySeconds: RETURN_DELAYS_SECONDS[0],
        },
        {
            id: "d2",
            title: "The rooftops are still lit",
            body: "Your best distance is waiting to be beaten.",
            delaySeconds: RETURN_DELAYS_SECONDS[1],
        },
        {
            id: "d3",
            title: "One more run",
            body: "Fresh missions and a supply drop are stacking up.",
            delaySeconds: RETURN_DELAYS_SECONDS[2],
        },
    ],
    schedule: (input) => rearmLocalNotification(input),
    cancel: async (id) => {
        // This game's canceller reports whether the host took it; the shared
        // module does not need the answer, so drop it rather than widen the type.
        await cancelLocalNotification(id);
    },
    resolveLaunch: () => resolveLaunchIntent(),
    // The cached permission annotates the scheduled event; it must never gate
    // scheduling. A stale or failed boot probe would otherwise silence the
    // whole cadence for the session, and a mid-session grant would never arm.
    permissionHint: () => notificationsGranted,
    track: (event, payload) => analytics.event(event, payload),
});

/**
 * Resolve a notification-driven launch and record it. Call once at startup so
 * the return can be attributed to the reminder copy that earned it.
 */
export async function resolveReturnLaunch(): Promise<string | null> {
    const reminderId = await returnReminders.resolveLaunch();
    if (reminderId) analytics.event("retention_notification_return_play", { reminder_id: reminderId });
    return reminderId;
}
