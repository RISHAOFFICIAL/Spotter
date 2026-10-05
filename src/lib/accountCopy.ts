/**
 * accountCopy — the visible strings of the account-level actions on the Profile
 * surface, in ONE place, derived from nothing else.
 *
 * WHY THIS MODULE EXISTS (owner directive 2026-10-05; same discipline as
 * src/lib/promises.ts, which owns the Profile captions, and
 * src/lib/notificationPrefs.ts, which owns NOTIFICATION_META): the offline gate
 * that proves the sign-out control is wired (scripts/smoke/signout-feed-labels-
 * guard.cjs) asserts the rendered tree against these exact strings, so a
 * reworded control must fail the gate rather than silently drift from the
 * check. Copy is product copy: one place to change, one place to check.
 *
 * Sign-out copy rules, for whoever edits it:
 *  - never claim anything is deleted (it is not — that is what DANGER ZONE's
 *    "Delete account" does, and the two must never read alike);
 *  - no urgency, no scolding, no "are you sure you want to leave?";
 *  - the failure sentence is for a sign-out that did NOT happen and must say so
 *    plainly (no silent no-op: see ProfileScreen.runSignOut).
 */

/** What the control on the Profile surface says. */
export const SIGN_OUT_CONTROL_LABEL = 'Sign out';

/** Quiet line under the control — what signing out does NOT do. */
export const SIGN_OUT_CAPTION = 'You can sign back in anytime. Nothing is deleted.';

/** iOS-standard confirmation, raised before the session is touched. */
export const SIGN_OUT_CONFIRM_TITLE = 'Sign out?';
export const SIGN_OUT_CONFIRM_BODY = 'You can sign back in anytime with your email and password.';

/** The two buttons of that confirmation (Cancel is style:'cancel'). */
export const SIGN_OUT_CONFIRM_ACTION = 'Sign out';
export const SIGN_OUT_CANCEL_ACTION = 'Cancel';

/**
 * Shown when the session is still there after signing out — either the call
 * threw or the stored session survived it (offline). The user is NOT routed
 * away, and the control comes back so they can try again.
 */
export const SIGN_OUT_FAILED_MESSAGE = 'Couldn\u2019t sign out. Try again.';
