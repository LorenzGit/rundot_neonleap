import {
    cancelLocalNotification,
    getRunCapabilities,
    localNotificationsEnabled,
    recordAnalytics,
    scheduleLocalNotification,
    setLocalNotificationsEnabled,
} from "../sdk/runSdk.ts";
import { saveSystem } from "./save.ts";
import { msUntilNextLocalMidnight, serverNow, trustedTimeGate } from "./serverTime.ts";

/**
 * One reminder, for the one thing a player actually loses by not coming back:
 * the nightly supply drop of cells. There is deliberately no streak-nag,
 * and no re-engagement ping for simply not playing — a notification has to be
 * worth the interruption or it is spam with the game's name on it.
 *
 * Everything here fails closed. No host, no permission, or no trusted clock
 * means no reminder, never an optimistic one.
 */

const DAILY_REMINDER_ID = "neonleap-supply-drop";

/**
 * Reminders land mid-morning rather than at the stroke of local midnight, when
 * the reward technically unlocks. Waking someone at 00:00 to tell them about
 * free cells is how a game gets its notifications turned off for good.
 */
export const REMINDER_HOUR_AFTER_MIDNIGHT = 9;

export interface ReminderView {
    /** Whether the platform can deliver reminders at all on this device. */
    supported: boolean;
    /** The player's in-game preference. */
    wanted: boolean;
    /** Whether the platform permission is actually granted. */
    granted: boolean;
    label: string;
}

let permissionGranted = false;
let permissionChecked = false;

export async function refreshNotificationPermission(): Promise<void> {
    permissionGranted = await localNotificationsEnabled();
    permissionChecked = true;
}

export function reminderView(): ReminderView {
    const supported = getRunCapabilities().notifications;
    const wanted = saveSystem.get().settings.dailyReminder;
    if (!supported) return { supported, wanted, granted: false, label: "UNAVAILABLE HERE" };
    if (!wanted) return { supported, wanted, granted: permissionGranted, label: "OFF" };
    if (!permissionChecked) return { supported, wanted, granted: false, label: "CHECKING" };
    return {
        supported,
        wanted,
        granted: permissionGranted,
        label: permissionGranted ? `DAILY · ABOUT ${REMINDER_HOUR_AFTER_MIDNIGHT}AM` : "ALLOW IN SYSTEM SETTINGS",
    };
}

/**
 * Seconds from now until the reminder should fire: the next local midnight the
 * reward unlocks on, pushed to a civil hour. Returns null when the clock cannot
 * be trusted, because a reminder scheduled off a rolled device clock is noise.
 */
export function secondsUntilNextReminder(nowMs: number = serverNow()): number | null {
    if (!trustedTimeGate().ready) return null;
    const untilMidnight = msUntilNextLocalMidnight(nowMs);
    if (!Number.isFinite(untilMidnight) || untilMidnight < 0) return null;
    return Math.round((untilMidnight + REMINDER_HOUR_AFTER_MIDNIGHT * 3_600_000) / 1000);
}

/**
 * Called from a real gesture when the player flips the setting. Turning it on
 * asks the platform for permission; turning it off cancels anything pending.
 */
export async function setDailyReminderEnabled(enabled: boolean): Promise<ReminderView> {
    saveSystem.updateSettings({ dailyReminder: enabled });
    void saveSystem.flush();
    if (!enabled) {
        await cancelLocalNotification(DAILY_REMINDER_ID);
        recordAnalytics("daily_reminder_disabled");
        return reminderView();
    }
    permissionGranted = await setLocalNotificationsEnabled(true);
    permissionChecked = true;
    recordAnalytics("daily_reminder_enabled", { granted: permissionGranted });
    await syncDailyReminder();
    return reminderView();
}

/**
 * Re-arms the reminder for the next unlock. Safe to call often: the stable
 * notification id means the host replaces rather than stacks, so a player who
 * opens the game five times a day does not collect five reminders.
 */
export async function syncDailyReminder(): Promise<boolean> {
    const settings = saveSystem.get().settings;
    if (!getRunCapabilities().notifications) return false;
    if (!settings.dailyReminder) return false;
    // The boot-time permission probe is a HINT, never a gate. Permission can
    // be granted after boot (system settings, a host prompt, a later session
    // toggle), and a cached `false` gating this call is exactly how a daily
    // reminder ships dead for the whole session. Re-read — a read never
    // prompts — then attempt regardless: an ungranted schedule is a free
    // no-op, a stale `false` is not.
    await refreshNotificationPermission();

    const delaySeconds = secondsUntilNextReminder();
    if (delaySeconds === null) return false;

    const scheduled = await scheduleLocalNotification({
        notificationId: DAILY_REMINDER_ID,
        title: "A FRESH PAGE",
        body: "Your nightly supply drop is ready. The skyline kept running without you.",
        delaySeconds,
        collapseKey: DAILY_REMINDER_ID,
    });
    recordAnalytics("daily_reminder_scheduled", {
        scheduled,
        delaySeconds,
        // Whether the cached probe agreed with the host's answer — the signal
        // that tells us if this gate would have been wrong.
        permission_cached: permissionGranted,
    });
    return scheduled;
}

/** The player is here, so today's reminder has done its job — clear it. */
export async function clearPendingReminder(): Promise<void> {
    if (!getRunCapabilities().notifications) return;
    await cancelLocalNotification(DAILY_REMINDER_ID);
}
