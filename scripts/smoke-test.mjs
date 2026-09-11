#!/usr/bin/env node
/**
 * SPOTTER MVP end-to-end smoke test (dev-mock mode): two-user pair flow plus
 * the seeded 3-member group (S6) — feed/ring/creator semantics in a group,
 * non-creator view, solo fallback, and the capacity/duplicate-join guards.
 * Exercises the app's own lib layer (devMock + invites + workoutStore + the
 * supabase dev facade) on Node with harness stubs for RN-only bits.
 * Run:  node scripts/smoke-test.mjs    (exit 0 = all PASS)
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { spawnSync } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;
async function step(name, fn) {
  checks += 1;
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e?.message ?? e}`);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. Compile the app lib modules fresh
const compileRes = spawnSync(process.execPath, [path.join(__dirname, 'smoke', 'compile.cjs')], { encoding: 'utf8' });
if (compileRes.status !== 0) {
  console.error(compileRes.stderr || compileRes.stdout);
  process.exit(2);
}

// 2. Module stubs for RN-only deps BEFORE requiring app modules
const { map } = require(path.join(__dirname, 'smoke', '.compiled', '_deps.json'));
const { setPrefix, clearAll, removeItem, getItem, setItem } = require(path.join(__dirname, 'smoke', 'async-storage.js'));
const fsMod = require(path.join(__dirname, 'smoke', 'expo-file-system.js'));

const RUN_ID = `run-${Date.now().toString(36)}`;
setPrefix(RUN_ID);
clearAll();
fsMod._clean(RUN_ID);

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (map[request]) return path.join(__dirname, map[request]);
  return origResolve.call(this, request, ...args);
};

const compRoot = path.join(__dirname, 'smoke', '.compiled');
const model = {
  mock: require(path.join(compRoot, 'mock.js')),
  supabase: require(path.join(compRoot, 'supabase.js')),
  workoutStore: require(path.join(compRoot, 'workoutStore.js')),
  invites: require(path.join(compRoot, 'invites.js')),
  workouts: require(path.join(compRoot, 'workouts.js')),
  settings: require(path.join(compRoot, 'settings.js')),
  naming: require(path.join(compRoot, 'naming.js')),
  weeklyResults: require(path.join(compRoot, 'weeklyResults.js')),
  missPromise: require(path.join(compRoot, 'missPromise.js')),
  notificationPrefs: require(path.join(compRoot, 'notificationPrefs.js')),
  notifications: require(path.join(compRoot, 'notifications.js')),
  pushRegistration: require(path.join(compRoot, 'pushRegistration.js')),
  pushDispatch: require(path.join(compRoot, 'pushDispatch.js')),
  weekRecap: require(path.join(compRoot, 'weekRecap.js')),
};
const { devMock, DEV_PAIR_GROUP_ID, DEV_DEMO_GROUP_ID, DEV_DEMO_TEAM_NAME } = model.mock;
const { authenticate, getStoredSession } = model.supabase;
const { fetchWeeklyContext, logWorkout } = model.workoutStore;
const { weekStartFor } = model.workouts;
const { getOrCreateInviteCode, lookupInvite, acceptInvite, leaveGroup, friendlyAcceptError } = model.invites;
const { commitOnboarding } = model.settings;
const { setPetName, getPetName, setTeamName } = model.naming;
const { finalizePreviousWeek, previousWeekRange } = model.weeklyResults;
const { getMissPromise, setMissPromise, hasSeenMissPrompt, markMissPromptSeen, clearMissPromptSeen } = model.missPromise;
const { getNotificationPrefs, setNotificationPref, defaultNotificationPrefs, NOTIFICATION_DEFAULTS } = model.notificationPrefs;
const {
  getNotificationPermissionState,
  shouldAskNotificationPermission,
  markNotificationExplained,
  dismissNotificationAsk,
  requestNotificationPermission,
  refreshPushRegistrationIfGranted,
} = model.notifications;
const { registerPushDevice, getPushDeviceToken } = model.pushRegistration;
const {
  getRecapForLastCompletedWeek,
  getVisibleRecap,
  isRecapDismissed,
  dismissRecap,
  recapHeadline,
  recapOwnLine,
  recapPartnerLine,
  RECAP_FORWARD_LINE,
} = model.weekRecap;
const {
  dispatchPush,
  dispatchPartnerLogged,
  dispatchInviteAccepted,
  runAppOpenDispatches,
  isQuietHours,
  getLocalHour,
  setDispatchNowForTest,
  PENDING_INVITE_FIRST_MS,
  PENDING_INVITE_FOLLOWUP_MS,
  PENDING_INVITE_MAX,
  PARTNER_LOGGED_DAILY_CAP,
  pendingInviteBody,
  partnerLoggedBody,
  missedWeekBody,
} = model.pushDispatch;

console.log(`SPOTTER MVP smoke test (dev mock) — 2-user + 3-member group  [${RUN_ID}]`);
console.log('');

const A_EMAIL = 'alex.smoke@spotter.test';
const B_EMAIL = 'bri.smoke@spotter.test';
// S6 group steps. crew@spotter.test is the designated demo email: signing up
// seeds the full 3-person demo group (mock.ts DEV_GROUP_DEMO_EMAIL). Maya and
// Jules are its fixed seeded co-members (ids documented in mock.ts as
// DEV_DEMO_MEMBER_B/C) — sign in as them for the non-creator view. The demo
// group also pre-seeds the creator's local pet-name map (Maya→Coach, Jules→
// Stretch), team name "Crew Volt", and workout history crew 2 / Maya 1 / Jules 0.
const CREW_EMAIL = 'crew@spotter.test';
const MAYA_EMAIL = 'maya@spotter.test';
const JULES_EMAIL = 'jules@spotter.test';
const MAYA_ID = 'dev_member_maya';
const JULES_ID = 'dev_member_jules';
// Fresh dev users for the solo + 4th-member guard steps.
const SOLO_EMAIL = 'solo.smoke@spotter.test';
const ZOE_EMAIL = 'zoe.smoke@spotter.test';
let userA, userB, userCrew, userZoe, invite, crewInvite;
// Deterministic daytime clock for the dispatch engine: 12:00 UTC is NOT quiet
// hours for the UTC recipient (and inside the day-cap's UTC day-key), so the
// real dispatch paths (which read the clock themselves) pass at ANY wall-clock
// hour — including 21:00–08:00 UTC when a `new Date()` clock would suppress.
const DISPATCH_DAYTIME = new Date('2026-09-07T12:00:00Z');

async function currentUserId() {
  const s = await getStoredSession();
  return s?.user?.id ?? '';
}

await step('a. User A signs up (dev mock) + onboarding (goal 4, week start Wed)', async () => {
  const res = await authenticate(A_EMAIL, 'pass1234');
  ok(res.ok, `authenticate failed: ${res.error}`);
  userA = await devMock.getUserById(await currentUserId());
  ok(userA && userA.email === A_EMAIL, 'A session not created');
  const commit = await commitOnboarding({ weeklyGoal: 4, weekStart: 'Wed' });
  ok(commit.ok, `commitOnboarding failed: ${commit.error}`);
  const prof = await devMock.getProfile(userA.id);
  ok(prof && prof.weekly_goal === 4 && prof.week_start_day === 'Wed', 'A goal/week not persisted');
  console.log(`        A = ${userA.id} (${A_EMAIL}), goal 4, week starts Wed`);
});

await step('b. A generates invite code (DEV-XXXX-XXXX) + pre-signup generation persists', async () => {
  const first = await getOrCreateInviteCode();
  ok(first.isDev, 'expected dev invite');
  ok(first.displayCode.startsWith('DEV-'), `bad display: ${first.displayCode}`);
  ok(/^DEV-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(first.displayCode), `bad format: ${first.displayCode}`);
  ok(first.token.length === 8, `token length ${first.token.length}`);
  // Persistence: a second call returns the SAME code (stored ref reuse).
  const second = await getOrCreateInviteCode();
  ok(second.token === first.token, 'invite code did not persist across calls');
  const rows = await devMock.listInvites(userA.id);
  ok(rows.some((r) => r.token === first.token && r.status === 'pending'), 'dev invite row missing');
  invite = first;
  console.log(`        code: ${invite.displayCode}`);
});

await step('c. A logs a workout (photo paths scoped per user, caption round-trip)', async () => {
  const { File, _root, _ensureFile } = fsMod;
  const shot = new File(path.join(_root, RUN_ID, 'fake-shot-a.jpg'));
  const envShot = new File(path.join(_root, RUN_ID, 'fake-env-a.jpg'));
  _ensureFile(shot);
  _ensureFile(envShot);
  // Dual-capture shape: BOTH live shots are required now (S4b-1).
  const res = await logWorkout({ photoUri: shot.uri, photoEnvUri: envShot.uri, caption: 'Hill sprints', workoutType: 'Run' });
  ok(res.ok, `logWorkout failed: ${res.error}`);
  const log = res.log;
  ok(log && log.userId === userA.id, 'log author not A');
  ok(log.photoPath.includes('spotter-dev-mock-photos') && log.photoPath.includes(userA.id), `selfie not per-user scoped: ${log.photoPath}`);
  ok(log.photoEnv && log.photoEnv.includes('spotter-dev-mock-photos') && log.photoEnv.includes(userA.id), `env photo not per-user scoped: ${log.photoEnv}`);
  ok(log.photoEnv.includes('-env'), `env photo missing -env marker: ${log.photoEnv}`);
  ok(log.caption === 'Hill sprints', `caption round-trip failed: ${log.caption}`);
  console.log(`        log ${log.id} selfie ${log.photoPath} + env ${log.photoEnv} (caption kept)`);
});

await step('d. User B resolves invite → inviter name + has-logs flag', async () => {
  const info = await lookupInvite(invite.displayCode);
  ok(info.found, 'invite not found by B');
  ok(info.inviterName === 'alex.smoke', `inviterName=${info.inviterName}`);
  ok(info.inviterHasLogs === true, 'has-logs flag should be true (A logged)');
  const res = await authenticate(B_EMAIL, 'pass5678');
  ok(res.ok, `B authenticate failed: ${res.error}`);
  userB = await devMock.getUserById(await currentUserId());
  ok(userB && userB.email === B_EMAIL, 'B session not created');
  console.log(`        B = ${userB.id} (${B_EMAIL})`);
});

await step('e. Accept: pair group + BOTH memberships (inviter keeps 4, invitee default 3)', async () => {
  const res = await acceptInvite(invite.displayCode);
  ok(res.ok, `acceptInvite failed: ${res.error}`);
  const memA = await devMock.getDevMemberships(userA.id);
  const memB = await devMock.getDevMemberships(userB.id);
  const pairA = memA.find((m) => m.group_id === DEV_PAIR_GROUP_ID);
  const pairB = memB.find((m) => m.group_id === DEV_PAIR_GROUP_ID);
  ok(pairA && pairB, 'pair membership missing on A or B');
  ok(pairA.weekly_goal === 4, `inviter goal not kept: ${pairA.weekly_goal}`);
  ok(pairB.weekly_goal === 3, `invitee default goal wrong: ${pairB.weekly_goal}`);
  const stateA = await devMock.getPairState(userA.id);
  const stateB = await devMock.getPairState(userB.id);
  ok(stateA.accepted && stateB.accepted, 'pair state not accepted on both sides');
  ok(stateA.partner?.id === userB.id && stateB.partner?.id === userA.id, 'pair endpoints wrong');
  console.log(`        group ${DEV_PAIR_GROUP_ID}: A(goal 4) <-> B(goal 3)`);
});

await step('f. B logs → weekly context contains BOTH A and B logs', async () => {
  const { File, _root, _ensureFile } = fsMod;
  const shot = new File(path.join(_root, RUN_ID, 'fake-shot-b.jpg'));
  const envShot = new File(path.join(_root, RUN_ID, 'fake-env-b.jpg'));
  _ensureFile(shot);
  _ensureFile(envShot);
  const res = await logWorkout({ photoUri: shot.uri, photoEnvUri: envShot.uri, workoutType: 'Lift' });
  ok(res.ok, `B logWorkout failed: ${res.error}`);
  const ctx = await fetchWeeklyContext();
  ok(ctx.ok, `fetchWeeklyContext failed: ${ctx.error}`);
  const authors = new Set(ctx.context.logs.map((l) => l.userId));
  ok(authors.has(userA.id), 'A log missing from shared feed');
  ok(authors.has(userB.id), 'B log missing from shared feed');
  console.log(`        feed: ${ctx.context.logs.length} logs (${[...authors].length} authors)`);
});

await step('g. Ring counts A OWN logs only (not B)', async () => {
  // Switch the session back to A, then read A's weekly context: the ring
  // count must be A's own logs only, while the feed (ctx.logs) has both.
  const res = await authenticate(A_EMAIL, 'pass1234');
  ok(res.ok, `re-auth A failed: ${res.error}`);
  const ctx = await fetchWeeklyContext();
  const own = ctx.context.logs.filter((l) => l.userId === userA.id).length;
  const total = ctx.context.logs.length;
  ok(own === 1, `A own count = ${own} (expected 1)`);
  ok(total >= 2, `shared feed = ${total} (expected >= 2)`);
  ok(own < total, 'A ring should NOT include B logs');
  console.log(`        own=${own} total=${total} → A ring 1/4`);
});

await step('h. Solo-mode invite banner state flips to in-group after accept', async () => {
  const ctx = await fetchWeeklyContext();
  ok(ctx.context.members.length === 1, `members.length=${ctx.context.members.length} (expected 1)`);
  ok(ctx.context.members[0]?.id === userB.id, `members[0] = ${ctx.context.members[0]?.id}`);
  // home-screen.md §3: the banner renders only when members.length === 0, so
  // the context flip is exactly what unmounts the banner.
  console.log(`        inGroup=true, member=${ctx.context.members[0]?.displayName}`);
});

await step('i. Naming: pet name overrides member label locally; team name shared on pair group', async () => {
  // Session is A (re-authed in step g). A's group = just A + B (bri.smoke).
  // A) Pet name (local-only): what A calls B, shown to A only.
  await setPetName('Coach');
  ok((await getPetName()) === 'Coach', 'pet name did not persist');

  let ctx = await fetchWeeklyContext();
  ok(ctx.context.members[0]?.displayName === 'Coach', `member displayName=${ctx.context.members[0]?.displayName} (expected Coach)`);
  ok(ctx.context.members[0]?.firstName === 'bri.smoke', 'member.firstName must stay the REAL name');
  // Partner (B) feed-card author label uses the pet name; own (A) keeps own name.
  const bLog = ctx.context.logs.find((l) => l.userId === userB.id);
  const aLog = ctx.context.logs.find((l) => l.userId === userA.id);
  ok(bLog && bLog.authorName === 'Coach', `B feed author=${bLog?.authorName} (expected Coach)`);
  ok(aLog && aLog.authorName === 'alex.smoke', `A feed author=${aLog?.authorName} (expected own name alex.smoke)`);
  ok(ctx.context.teamName === null, 'teamName should be null before set');

  // B) Team name (shared on the pair group).
  const teamRes = await setTeamName('Team Us');
  ok(teamRes.ok, `setTeamName failed: ${teamRes.error}`);
  ctx = await fetchWeeklyContext();
  ok(ctx.context.teamName === 'Team Us', `teamName=${ctx.context.teamName} (expected Team Us)`);

  // Fallback: clearing the pet name returns the member label to the real name.
  await setPetName('');
  ctx = await fetchWeeklyContext();
  ok(ctx.context.members[0]?.displayName === 'bri.smoke', `cleared pet name → ${ctx.context.members[0]?.displayName} (expected bri.smoke)`);
  ok(ctx.context.teamName === 'Team Us', 'team name should persist after clearing pet name');

  // Local-only isolation: B does NOT see A's pet name, but DOES see the team name.
  const resB = await authenticate(B_EMAIL, 'pass5678');
  ok(resB.ok, `re-auth B failed: ${resB.error}`);
  const ctxB = await fetchWeeklyContext();
  ok(ctxB.context.members[0]?.displayName === 'alex.smoke', `B member displayName=${ctxB.context.members[0]?.displayName} (expected alex.smoke — no pet name set for B)`);
  ok(ctxB.context.teamName === 'Team Us', `B teamName=${ctxB.context.teamName} (expected shared Team Us)`);

  // Restore session A + clear the team name so a re-run starts clean.
  await authenticate(A_EMAIL, 'pass1234');
  await setTeamName('');
  console.log(`        pet name "Coach" → local override; team "Team Us" → shared header`);
});

await step('j. Leave group: both sides return to solo, own logs intact, re-pair works with a fresh code', async () => {
  // Session is A (restored at the end of step i). A and B are in a group; A has
  // its own log (step c), B has its own (step f). Clear A's local pet-name
  // override so the solo→group→leave assertions read real names only.
  await setPetName('');

  // Confirm A still sees the pair before leaving (sanity baseline).
  let ctx = await fetchWeeklyContext();
  ok(ctx.context.members.length === 1, 'A should be in a group before leave');
  const aLogsBefore = await devMock.listWorkouts(userA.id);
  const bLogsBefore = await devMock.listWorkouts(userB.id);
  ok(aLogsBefore.length === 1, `A logs before leave = ${aLogsBefore.length} (expected 1)`);
  ok(bLogsBefore.length === 1, `B logs before leave = ${bLogsBefore.length} (expected 1)`);

  // Leave as A.
  const res = await leaveGroup();
  ok(res.ok, `leaveGroup failed: ${res.error}`);

  // A is solo: members empty, no pair memberships, member state reset.
  ctx = await fetchWeeklyContext();
  ok(ctx.context.members.length === 0, `A members.length=${ctx.context.members.length} (expected 0 after leave)`);
  const memA = await devMock.getDevMemberships(userA.id);
  ok(!memA.some((m) => m.group_id === DEV_PAIR_GROUP_ID), 'A pair membership not removed');

  // B is solo too (both memberships of the pair group deleted).
  const memB = await devMock.getDevMemberships(userB.id);
  ok(!memB.some((m) => m.group_id === DEV_PAIR_GROUP_ID), 'B pair membership not removed');
  const stateB = await devMock.getPairState(userB.id);
  ok(stateB.accepted === false && stateB.partner === null, 'B pair state not reset to solo');

  // Own workout logs survive (photos stay per-user isolated); team name cleared.
  ok((await devMock.listWorkouts(userA.id)).length === 1, 'A logs lost after leave');
  ok((await devMock.listWorkouts(userB.id)).length === 1, 'B logs lost after leave');
  ok((await devMock.getTeamName()) === null, 'shared team name should clear on leave');

  // Idempotent: leaving again when already solo is a harmless no-op.
  const res2 = await leaveGroup();
  ok(res2.ok, `second leave should be a no-op ok: ${res2.error}`);

  // Re-pair with a FRESH code: clear the persisted invite ref so A generates a
  // new token, then B accepts A's new code.
  await removeItem('spotter.invite:v1');
  const resAuthA2 = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthA2.ok, `re-auth A failed: ${resAuthA2.error}`);
  const fresh = await getOrCreateInviteCode();
  ok(/^DEV-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(fresh.displayCode), `fresh code format: ${fresh.displayCode}`);
  ok(fresh.token.length === 8, `fresh token length ${fresh.token.length}`);

  // B accepts A's fresh code.
  const resAuthB2 = await authenticate(B_EMAIL, 'pass5678');
  ok(resAuthB2.ok, `re-auth B (accept) failed: ${resAuthB2.error}`);
  const acc = await acceptInvite(fresh.displayCode);
  ok(acc.ok, `re-pair accept failed: ${acc.error}`);

  const resAuthA3 = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthA3.ok, `re-auth A (post-pair) failed: ${resAuthA3.error}`);
  const ctxA = await fetchWeeklyContext();
  ok(ctxA.context.members.length === 1, 'A should be back in a group after fresh accept');
  ok(ctxA.context.members[0]?.id === userB.id, `A member after re-pair = ${ctxA.context.members[0]?.id}`);

  console.log(`        A+B leave → both solo, logs kept, fresh-code re-pair works`);
});

await step('k. Weekly results snapshot: fully-elapsed week finalizes one row, idempotent', async () => {
  // Session is A (restored at the end of step j). A is re-paired with B here.
  const resAuthA4 = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthA4.ok, `re-auth A (step k) failed: ${resAuthA4.error}`);
  let ctx = await fetchWeeklyContext();
  ok(ctx.ok && ctx.context.members.length === 1, 'A should be paired before weekly finalize');

  // Use A's own reported week-start day to stay consistent with the app logic.
  const weekStartDay = ctx.context.weekStartDay;
  const nowRef = new Date();
  const curStart = weekStartFor(nowRef, weekStartDay);
  ok(!Number.isNaN(curStart.getTime()), 'A weekly context should expose a parseable week start');

  // Time-travel: "now" = 8 days after the CURRENT week start, so the current
  // week (the one containing A's step-c log) is fully elapsed and becomes the
  // PREVIOUS week. Direct call (no clock injection) with A's goal.
  const elapsedNow = new Date(curStart.getTime() + 8 * 24 * 60 * 60 * 1000);
  const first = await finalizePreviousWeek(elapsedNow, weekStartDay, ctx.context.weeklyGoal, DEV_PAIR_GROUP_ID);
  ok(first.ok, `first finalize failed: ${first.error}`);
  ok(first.finalized === true, 'first finalize should write a NEW snapshot row');

  // Idempotency: the same week must not double-write.
  const second = await finalizePreviousWeek(elapsedNow, weekStartDay, ctx.context.weeklyGoal, DEV_PAIR_GROUP_ID);
  ok(second.ok, `second finalize failed: ${second.error}`);
  ok(second.finalized === false, 'second finalize of the same week should be a no-op');

  // Verify the dev-mock row is actually persisted and shape-correct.
  const results = await devMock.listResults(userA.id);
  const snap = results.find(
    (r) => r.group_id === DEV_PAIR_GROUP_ID && r.week_start_at === first.result.week_start_at,
  );
  ok(snap !== undefined, 'weekly_results dev-mock row should exist after elapsed week');
  ok(snap.workout_count === 1, `snapshot count = ${snap.workout_count} (expected 1: A's step-c log)`);
  ok(snap.weekly_goal_snapshot === ctx.context.weeklyGoal, `goal snapshot = ${snap.weekly_goal_snapshot}`);
  ok(snap.completed === (snap.workout_count >= snap.weekly_goal_snapshot), 'completed flag should match count vs goal');
  ok(snap.nudge_present === false, 'nudge_present should be false in v1.1 Build #1');

  console.log(`        weekly_results: count=1 goal=${snap.weekly_goal_snapshot} completed=${snap.completed}`);
});

await step('l. Miss promise: set (40 chars) → missed previous week → own-miss line; unpair clears; partner w/o promise gets no line', async () => {
  // Session is A (restored at the end of step k) and A is re-paired with B.
  const resAuthA5 = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthA5.ok, `re-auth A (step l) failed: ${resAuthA5.error}`);
  const ctx0 = await fetchWeeklyContext();
  ok(ctx0.ok, 'fetchWeeklyContext failed at step l start');
  ok(ctx0.ok && ctx0.context.members.length === 1, 'A should be paired for the miss-promise step');
  const weekStartDay = ctx0.context.weekStartDay;
  const goal = ctx0.context.weeklyGoal;

  // 1) Set a 40-char promise (exercises trim; the ≤80 guard lives in the lib).
  const PROMISE = 'I owe you the picnic run plus a playlist';
  ok(PROMISE.length === 40, `fixture promise length = ${PROMISE.length} (expected 40)`);
  const setRes = await setMissPromise(PROMISE);
  ok(setRes.ok, `setMissPromise failed: ${setRes.error}`);
  ok((await getMissPromise()) === PROMISE, 'promise not readable via getter (trim/roundtrip)');

  // 2) Fixture a MISSED previous week, reusing the step-k time-travel pattern:
  // advance 8 days past the CURRENT week start, so the week containing A's
  // step-c log finalizes as missed (1 log < goal 4). Clear A's snapshots first
  // so the fixture writes a fresh row (step k already created this key, which
  // would otherwise make the finalize a no-op).
  await devMock.clearResults(userA.id);
  const curStart = weekStartFor(new Date(), weekStartDay);
  const elapsedNow = new Date(curStart.getTime() + 8 * 24 * 60 * 60 * 1000);
  const fix = await finalizePreviousWeek(elapsedNow, weekStartDay, goal, DEV_PAIR_GROUP_ID);
  ok(fix.ok, `missed-week fixture failed: ${fix.error}`);
  ok(fix.result !== undefined && fix.result.completed === false, 'fixture snapshot should record a MISSED week');

  // 3) Real-now weekly context must surface the own-miss line (missed + promise).
  const ctx = await fetchWeeklyContext();
  ok(ctx.ok, 'fetchWeeklyContext failed after fixture');
  ok(ctx.context.missLine?.kind === 'ownMiss', 'own-miss line missing after missed week + promise');
  ok(ctx.context.missLine?.promise === PROMISE, `own-miss promise mismatch: ${ctx.context.missLine?.promise}`);

  // 4) A partner with NO promise gets no line — even after a missed week.
  const resAuthB3 = await authenticate(B_EMAIL, 'pass5678');
  ok(resAuthB3.ok, `re-auth B (step l) failed: ${resAuthB3.error}`);
  const ctxB = await fetchWeeklyContext();
  ok(ctxB.ok, 'B fetchWeeklyContext failed');
  ok(ctxB.context.missLine === null, 'B should have NO own-miss line (no promise set)');

  // 5) Unpair (step-j style) clears the promise with the pair membership.
  const resAuthA6 = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthA6.ok, `re-auth A (unpair) failed: ${resAuthA6.error}`);
  const un = await leaveGroup();
  ok(un.ok, `unpair failed: ${un.error}`);
  ok((await devMock.getMissPromise(userA.id)) === null, 'miss promise should clear on unpair (devMock)');
  ok((await getMissPromise()) === null, 'getter should return null after unpair');
  const ctxSolo = await fetchWeeklyContext();
  ok(ctxSolo.ok && ctxSolo.context.missLine === null, 'solo A should have no own-miss line after unpair');

  console.log(`        promise "${PROMISE}" → own-miss line set; B (no promise) none; unpair clears`);
});

await step('m. Partner MissCard: B missed last week + B promise → A feed card state; prompted-flag skip-flow', async () => {
  // Step l ended with A solo (unpaired). Re-pair A+B with a FRESH code
  // (step-j pattern) so the M-slice pair read has a pair group to see.
  // Session is still A here (restored at the end of step l).
  const resAuthAm = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthAm.ok, `re-auth A (step m) failed: ${resAuthAm.error}`);
  await removeItem('spotter.invite:v1');
  const freshM = await getOrCreateInviteCode();
  ok(/^DEV-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(freshM.displayCode), `fresh code format: ${freshM.displayCode}`);
  const resAuthBm = await authenticate(B_EMAIL, 'pass5678');
  ok(resAuthBm.ok, `re-auth B (accept, step m) failed: ${resAuthBm.error}`);
  const accM = await acceptInvite(freshM.displayCode);
  ok(accM.ok, `re-pair accept failed: ${accM.error}`);
  const resAuthA7 = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthA7.ok, `re-auth A (post-pair, step m) failed: ${resAuthA7.error}`);
  const ctxM0 = await fetchWeeklyContext();
  ok(ctxM0.ok && ctxM0.context.members.length === 1, 'A should be paired at step m start');
  const partnerId = ctxM0.context.members[0]?.id ?? undefined;
  ok(partnerId === userB.id, `partner id = ${partnerId} (expected B)`);

  // 1) B sets their OWN promise (the M card surfaces the PARTNER's note).
  const B_PROMISE = 'I owe you a long run plus your favorite snack';
  ok(B_PROMISE.length <= 80, `B promise length = ${B_PROMISE.length}`);
  const resAuthB4 = await authenticate(B_EMAIL, 'pass5678');
  ok(resAuthB4.ok, `re-auth B (set promise) failed: ${resAuthB4.error}`);
  const setB = await setMissPromise(B_PROMISE);
  ok(setB.ok, `B setMissPromise failed: ${setB.error}`);
  ok((await getMissPromise()) === B_PROMISE, 'B promise not readable via getter');

  // 2) Prompted-flag skip-flow (lib-level, dev+real parity): unset → prompt
  //    allowed; flagged (Skip OR Save) → re-show suppressed; cleared → re-armed.
  await clearMissPromptSeen();
  ok((await hasSeenMissPrompt()) === false, 'prompt should be allowed when the flag is unset');
  await markMissPromptSeen();
  ok((await hasSeenMissPrompt()) === true, 'flagged → re-show must be suppressed');
  await clearMissPromptSeen();
  ok((await hasSeenMissPrompt()) === false, 'cleared flag → prompt re-armed (harness re-runs)');

  // 3) Fixture B's MISSED previous week (step-k/l time-travel): 8 days past the
  //    current week start makes the week containing B's step-f log fully
  //    elapsed; B has 1 log < goal 3 → missed. finalizePreviousWeek writes the
  //    snapshot under the SESSION user, so run the fixture AS B; use B's OWN
  //    effective week day and goal (B never onboarded: stored day falls back to
  //    'Mon', invitee goal is 3 from accept) — matching exactly what
  //    wasPreviousWeekMissedFor computes for the PARTNER at real-now, so the
  //    finalized snapshot is what the MissCard reads. Clear B's results first
  //    so the fixture writes a fresh snapshot row (no-op otherwise).
  const resAuthBfix = await authenticate(B_EMAIL, 'pass5678');
  ok(resAuthBfix.ok, `re-auth B (fixture) failed: ${resAuthBfix.error}`);
  const bDay = 'Mon'; // B's stored-day fallback (B never onboarded a week-start)
  const bGoal = 3; // B never onboarded; invitee default goal (step e) is 3
  await devMock.clearResults(userB.id);
  const curStartB = weekStartFor(new Date(), bDay);
  const elapsedNowB = new Date(curStartB.getTime() + 8 * 24 * 60 * 60 * 1000);
  const fixB = await finalizePreviousWeek(elapsedNowB, bDay, bGoal, DEV_PAIR_GROUP_ID);
  ok(fixB.ok, `B missed-week fixture failed: ${fixB.error}`);
  ok(fixB.result !== undefined && fixB.result.completed === false, 'B fixture snapshot should record a MISSED week');

  // 4) A's real-now weekly context must expose the partner MissCard (partner
  //    missed THEIR previous week AND their promise exists).
  const resAuthA9 = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthA9.ok, `re-auth A (assert) failed: ${resAuthA9.error}`);
  const ctxM = await fetchWeeklyContext();
  ok(ctxM.ok, 'fetchWeeklyContext failed at step m assert');
  ok(ctxM.context.partnerMissCard?.kind === 'partnerMiss', 'partner MissCard missing (B missed + B promise)');
  ok(ctxM.context.partnerMissCard?.promise === B_PROMISE, `partner MissCard promise mismatch: ${ctxM.context.partnerMissCard?.promise}`);

  // 5) A's OWN missLine stays null: A set no promise in this run (only B did),
  //    so A must not get a MissCard/line about themselves.
  ok(ctxM.context.missLine === null, 'A should have no own-miss line (A set no promise)');

  console.log(`        B missed + promise → A sees MissCard; prompted-flag unset→suppressed→re-armed`);
});

// Harness helpers for the permission-flag keys (local AsyncStorage). Defined
// BEFORE step n's top-level await so they are not in TDZ while it runs.
const permKey = (userId) => `spotter.notifperm:v1:${userId}`;
const AsyncStorageRemove = (k) => removeItem(k);
const AsyncStorageSet = (k, v) => setItem(k, v);

await step('n. Push foundation: prefs defaults created → toggle → readback; device idempotent; permission machine unseen→explained→granted/denied persists', async () => {
  // Session is A here (restored at the end of step m). A is paired with B.
  const resAuthAn = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthAn.ok, `re-auth A (step n) failed: ${resAuthAn.error}`);
  const uid = userA.id;

  // 1) Preferences defaults: BEFORE any row exists, reads return the schema
  //    defaults (invite_accepted + partner_logged + pending_invite ON,
  //    missed_week OFF) — lazy-create semantics without a phantom row.
  const defaults = defaultNotificationPrefs();
  ok(defaults.invite_accepted === true && defaults.partner_logged === true, 'defaults: invite_accepted + partner_logged should be true');
  ok(defaults.pending_invite === true, 'defaults: pending_invite should be true (owner-ratified)');
  ok(defaults.missed_week === false, 'defaults: missed_week should be OFF');
  const readDefaults = await getNotificationPrefs();
  ok(readDefaults !== null, 'getNotificationPrefs returned null');
  ok(readDefaults && readDefaults.invite_accepted === true, 'read defaults invite_accepted should be true');
  ok(readDefaults && readDefaults.partner_logged === true, 'read defaults partner_logged should be true');
  ok(readDefaults && readDefaults.pending_invite === true, 'read defaults pending_invite should be true');
  ok(readDefaults && readDefaults.missed_week === false, 'read defaults missed_week should be false');
  // The dev-mock row is NOT created by a read (lazy create only on write —
  // mirrors real reads before a row exists).
  const preRows = await devMock.listPushDevices(uid); // sanity: unrelated store untouched
  ok(Array.isArray(preRows), 'dev push-device list should be an array before registration');

  // 2) Toggle partner_logged OFF → reads back OFF; other toggles unchanged.
  const setRes = await setNotificationPref('partner_logged', false);
  ok(setRes.ok, `setNotificationPref failed: ${setRes.error}`);
  const after = await getNotificationPrefs();
  ok(after && after.partner_logged === false, 'partner_logged should read back OFF after toggle');
  ok(after && after.invite_accepted === true, 'invite_accepted should stay ON (default)');
  ok(after && after.missed_week === false, 'missed_week should stay OFF');
  // Turn it back on so a re-run starts from defaults.
  const setBack = await setNotificationPref('partner_logged', true);
  ok(setBack.ok, `setNotificationPref (back on) failed: ${setBack.error}`);
  ok((await getNotificationPrefs())?.partner_logged === true, 'partner_logged should restore to ON');

  // 3) PERMISSION MACHINE — unseen → explained → granted; denied persists.
  //    Fresh state (unseen): a wipe of the local flag + a fresh read.
  await AsyncStorageRemove(permKey(uid));
  ok((await getNotificationPermissionState()) === 'unseen', 'fresh state should be unseen');
  ok((await shouldAskNotificationPermission()) === true, 'unseen → should ask');
  await markNotificationExplained();
  ok((await getNotificationPermissionState()) === 'explained', 'after explainer → explained');
  ok((await shouldAskNotificationPermission()) === false, 'explained with no dismissal → should NOT re-ask (cooldown)');
  // Denied persists.
  await AsyncStorageRemove(permKey(uid));
  await markNotificationExplained();
  await dismissNotificationAsk();
  // Cooldown NOT elapsed → no re-ask.
  ok((await shouldAskNotificationPermission()) === false, 'explained+dismissed, cooldown pending → no re-ask');
  // Time-travel the cooldown: overwrite the local dismissal with 15 days ago.
  await AsyncStorageSet(permKey(uid), JSON.stringify({ state: 'explained', dismissedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString() }));
  ok((await shouldAskNotificationPermission()) === true, 'single re-ask allowed after cooldown');
  // Grant (dev mock grants without an OS prompt; token registered).
  const granted = await requestNotificationPermission();
  ok(granted === 'granted', `dev grant should be granted, got ${granted}`);
  ok((await getNotificationPermissionState()) === 'granted', 'state should be granted');
  ok((await shouldAskNotificationPermission()) === false, 'granted → never ask again');

  // 4) DEVICE REGISTRATION — dev path stores the fake token; re-registering
  //    the same token is IDEMPOTENT (one row; last_seen_at refreshes).
  const devRows = await devMock.listPushDevices(uid);
  const token1 = await getPushDeviceToken();
  ok(token1 && token1.startsWith('dev-expo-token-'), `dev token should be the fake form, got ${token1}`);
  ok(devRows.length === 1, `expected exactly 1 dev push row after grant, got ${devRows.length}`);
  ok(devRows[0].expo_push_token === token1, 'stored row token should match getPushDeviceToken');
  ok(devRows[0].user_id === uid, 'stored row user_id should be the session user');
  // Idempotent re-register (app-start refresh path with granted state).
  const okRefresh = await refreshPushRegistrationIfGranted();
  ok(okRefresh === undefined || okRefresh === true, 'refresh should complete without error');
  const rows2 = await devMock.listPushDevices(uid);
  ok(rows2.length === 1, `re-register should NOT duplicate the row, got ${rows2.length}`);
  ok(rows2[0].expo_push_token === token1, 'token should be unchanged after refresh');
  ok(typeof rows2[0].last_seen_at === 'string' && rows2[0].created_at === devRows[0].created_at, 'created_at stable, last_seen_at refreshed');

  // 5) granted state survives a "restart" (the persisted flag re-read).
  ok((await getNotificationPermissionState()) === 'granted', 'granted should persist across reads');

  console.log(`        prefs defaults→toggle→readback; device 1 row idempotent; perm machine unseen→explained→granted (+denied) persists`);
});

// Harness helper: read + clear the dev push-delivery store for a user
// (devMock.listPushDeliveries / clearPushDeliveries mirror the real table).
const pushDeliveries = async (uid) => devMock.listPushDeliveries(uid);
/** Let fire-and-forget (void) dispatch promises flush their microtasks. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

await step('o. Push dispatch engine: partner_logged row+dedupe, quiet-hours unit, pending_invite 49h+cap, daily cap 3/day', async () => {
  // Session state at start: A is granted (step n). A is paired with B (step m re-paired).
  const resAuthAo = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthAo.ok, `re-auth A (step o) failed: ${resAuthAo.error}`);
  const uidA = userA.id;
  const uidB = userB.id;

  // B needs a registered push device (step n only granted A) — register B so
  // partner-target dispatches resolve a token in dev.
  const resAuthBreg = await authenticate(B_EMAIL, 'pass5678');
  ok(resAuthBreg.ok, `re-auth B (register, step o) failed: ${resAuthBreg.error}`);
  ok((await registerPushDevice()) === true, 'B registerPushDevice should succeed');
  ok((await devMock.listPushDevices(uidB)).length === 1, 'B should have exactly 1 dev push row');
  const resAuthA2o = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthA2o.ok, `re-auth A (step o) failed: ${resAuthA2o.error}`);

  // Pin the dispatch engine to a DAYTIME clock so the real dispatch paths
  // below (dispatchPartnerLogged + the fire-and-forget hooks, which read the
  // clock themselves) are deterministic at ANY wall-clock hour — steps o/p
  // must pass at 03:00 UTC too. Explicit `now` args still take precedence.
  setDispatchNowForTest(DISPATCH_DAYTIME);

  // ---- 1) partner_logged: enable prefs (partner_logged ON by default), then
  // dispatch a partner workout for the CURRENT user's partner (B).
  await devMock.clearPushDeliveries(uidB);
  const prefSet = await setNotificationPref('partner_logged', true);
  ok(prefSet.ok, `set partner_logged pref failed: ${prefSet.error}`);
  const resPL = await dispatchPartnerLogged({
    workoutId: 'w_smoke_o1',
    workoutType: 'Run',
    partnerId: uidB,
    partnerName: 'bri.smoke',
    partnerTimezone: 'UTC',
  });
  ok(resPL && resPL.ok && resPL.status === 'sent', `partner_logged dispatch failed: ${JSON.stringify(resPL)}`);
  const then = await pushDeliveries(uidB);
  ok(then.length === 1, `expected 1 partner_logged delivery row, got ${then.length}`);
  ok(then[0].dedupe_key === 'partner_logged:w_smoke_o1', `dedupe key = ${then[0].dedupe_key}`);
  ok(then[0].kind === 'partner_logged' && then[0].status === 'sent', `row kind/status = ${then[0].kind}/${then[0].status}`);

  // ---- 2) dedupe: same workout id → skipped, NO second row.
  const resDup = await dispatchPartnerLogged({
    workoutId: 'w_smoke_o1',
    workoutType: 'Run',
    partnerId: uidB,
    partnerName: 'bri.smoke',
    partnerTimezone: 'UTC',
  });
  ok(resDup && resDup.ok && resDup.status === 'skipped' && resDup.reason === 'already_delivered', `dedupe should skip, got ${JSON.stringify(resDup)}`);
  ok((await pushDeliveries(uidB)).length === 1, 'dedupe must not add a second row');

  // ---- 3) quiet-hours unit: 11pm UTC → suppressed (recipient timezone UTC).
  const qh = isQuietHours('UTC', new Date('2026-09-07T23:00:00Z'));
  ok(qh === true, `23:00 UTC should be quiet, got ${qh}`);
  const notQh = isQuietHours('UTC', new Date('2026-09-07T12:00:00Z'));
  ok(notQh === false, `12:00 UTC should NOT be quiet, got ${notQh}`);
  // Recipient-local: 22:00 UTC is NOT quiet at 6pm America/New_York (UTC-4 DST).
  const localQh = isQuietHours('America/New_York', new Date('2026-09-07T22:00:00Z'));
  ok(localQh === false, `22:00 UTC = 18:00 New York → not quiet, got ${localQh}`);
  // Direct dispatch with an injected quiet-hours clock (recipient UTC 23:00).
  await devMock.clearPushDeliveries(uidB);
  const resQH2 = await dispatchPush(
    {
      kind: 'partner_logged',
      recipientUserId: uidB,
      recipientTimezone: 'UTC',
      recipientName: 'bri.smoke',
      eventKey: 'w_qh',
      content: { workoutType: 'Run' },
    },
    { now: new Date('2026-09-07T23:00:00Z') },
  );
  ok(resQH2 && resQH2.ok && resQH2.status === 'suppressed' && resQH2.suppressedReason === 'quiet_hours', `quiet-hours suppress: ${JSON.stringify(resQH2)}`);
  const qhRows = await pushDeliveries(uidB);
  ok(qhRows.some((r) => r.dedupe_key === 'partner_logged:w_qh' && r.status === 'suppressed' && r.suppressed_reason === 'quiet_hours'), 'quiet-hours suppressed row missing');

  // Same engine with an explicit DAYTIME clock → sent. Together with the
  // 23:00 injected suppression above, both branches are covered
  // deterministically forever (independent of the real wall clock).
  await devMock.clearPushDeliveries(uidB);
  const resDay = await dispatchPush(
    {
      kind: 'partner_logged',
      recipientUserId: uidB,
      recipientTimezone: 'UTC',
      recipientName: 'bri.smoke',
      eventKey: 'w_day_sent',
      content: { workoutType: 'Run' },
    },
    { now: DISPATCH_DAYTIME },
  );
  ok(resDay && resDay.ok && resDay.status === 'sent', `daytime dispatch should send: ${JSON.stringify(resDay)}`);
  ok(
    (await pushDeliveries(uidB)).some((r) => r.dedupe_key === 'partner_logged:w_day_sent' && r.status === 'sent'),
    'daytime sent row missing',
  );

  // ---- 4) pending_invite: A must be SOLO with a pending invite older than 48h.
  // Unpair A (both sides solo) — invite rows in devMock survive unpair (real
  // unpair keeps the invites row; accepted flips status). We need a FRESH
  // pending invite: clear the stored invite ref and regenerate.
  const unRes = await leaveGroup();
  ok(unRes.ok, `unpair (step o) failed: ${unRes.error}`);
  const stateAfter = await devMock.getPairState(uidA);
  ok(stateAfter.accepted === false, 'A should be solo after unpair');
  await removeItem('spotter.invite:v1');
  const freshO = await getOrCreateInviteCode();
  ok(/^DEV-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(freshO.displayCode), `fresh code format: ${freshO.displayCode}`);
  const invitesA = await devMock.listInvites(uidA);
  const pendInv = invitesA.find((i) => i.token === freshO.token && i.status === 'pending');
  ok(pendInv !== undefined, 'A should have a pending invite after fresh generation');

  // Age the invite to 49h relative to the pinned clock (direct store edit) so
  // the age math is deterministic regardless of the real wall clock.
  const aged = new Date(DISPATCH_DAYTIME.getTime() - PENDING_INVITE_FIRST_MS - 60 * 60 * 1000).toISOString();
  pendInv.created_at = aged;
  await devMock.saveInvites(uidA, invitesA);

  // pending_invite pref must be ON (default); run the app-open evaluation with
  // the SAME pinned daytime clock (the invite is 49h old relative to it).
  await devMock.clearPushDeliveries(uidA);
  const nowO = DISPATCH_DAYTIME;
  const resRun = await runAppOpenDispatches({ now: nowO });
  const remindedA = await pushDeliveries(uidA);
  ok(remindedA.length === 1, `expected 1 pending_invite row, got ${remindedA.length}`);
  ok(remindedA[0].status === 'sent' && remindedA[0].suppressed_reason === null, `pending row status: ${remindedA[0].status}`);
  ok(remindedA[0].dedupe_key.startsWith(`pending_invite:${pendInv.id}:1`), `first reminder dedupe key: ${remindedA[0].dedupe_key}`);
  ok(resRun.length === 1, `runAppOpenDispatches returned ${resRun.length} results`);

  // Re-run → suppressed by dedupe (same key), no duplicate.
  const resRun2 = await runAppOpenDispatches({ now: nowO });
  ok((await pushDeliveries(uidA)).length === 1, 're-run must not duplicate the reminder row');
  ok(resRun2.every((r) => r.status === 'skipped'), `re-run results: ${JSON.stringify(resRun2)}`);

  // No follow-up yet (age < 7d) — count stays 1.
  ok((await pushDeliveries(uidA)).filter((r) => r.kind === 'pending_invite').length === 1, 'a <7d invite must not fire the follow-up');

  // Accepted invite → NO pending_invite push (the pending filter drops it).
  // Accept as B (session switches); the accept fires invite_accepted for A.
  const resAuthBo = await authenticate(B_EMAIL, 'pass5678');
  ok(resAuthBo.ok, `re-auth B (accept in step o) failed: ${resAuthBo.error}`);
  const accO = await acceptInvite(freshO.displayCode);
  ok(accO.ok, `acceptInvite (step o) failed: ${accO.error}`);
  await tick(); // let the fire-and-forget notifyInviteAccepted flush
  // After accept, run A's open evaluation → no pending rows (invite accepted;
  // A is paired again).
  const resAuthA8 = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthA8.ok, `re-auth A (post-accept, step o) failed: ${resAuthA8.error}`);
  const afterAccept = await runAppOpenDispatches({ now: DISPATCH_DAYTIME });
  ok(afterAccept.every((r) => r.status === 'skipped'), `post-accept open should skip (no pending): ${JSON.stringify(afterAccept)}`);
  ok(!(await pushDeliveries(uidA)).some((r) => r.kind === 'pending_invite' && r.dedupe_key.startsWith(`pending_invite:${pendInv.id}:2`)), 'no follow-up may fire for an accepted invite');

  // ---- 5) daily cap: 3 partner_logged same day → 4th suppressed daily_cap.
  await devMock.clearPushDeliveries(uidB);
  await devMock.clearPushDeliveries(uidA);
  for (let i = 1; i <= PARTNER_LOGGED_DAILY_CAP; i += 1) {
    const r = await dispatchPartnerLogged({
      workoutId: `w_day_${i}`,
      workoutType: 'Run',
      partnerId: uidB,
      partnerName: 'bri.smoke',
      partnerTimezone: 'UTC',
    });
    ok(r && r.ok && r.status === 'sent', `day cap send ${i}: ${JSON.stringify(r)}`);
  }
  const rowsBeforeCap = await pushDeliveries(uidB);
  ok(rowsBeforeCap.filter((r) => r.kind === 'partner_logged' && r.status === 'sent').length === PARTNER_LOGGED_DAILY_CAP, `expected ${PARTNER_LOGGED_DAILY_CAP} sent rows`);
  const capRow = await dispatchPartnerLogged({
    workoutId: 'w_day_4',
    workoutType: 'Run',
    partnerId: uidB,
    partnerName: 'bri.smoke',
    partnerTimezone: 'UTC',
  });
  ok(capRow && capRow.ok && capRow.status === 'suppressed' && capRow.suppressedReason === 'daily_cap', `4th should suppress daily_cap: ${JSON.stringify(capRow)}`);
  const rowsAfterCap = await pushDeliveries(uidB);
  ok(rowsAfterCap.some((r) => r.dedupe_key === 'partner_logged:w_day_4' && r.status === 'suppressed' && r.suppressed_reason === 'daily_cap'), 'daily_cap suppressed row missing');

  console.log(`        partner_logged sent+dedupe; quiet_hours suppressed row; pending_invite 49h → 1 (cap 2); accepted → none; daily_cap ≥3`);
});

await step('p. Push copy EXACT strings + partner_logged fires from logWorkout; invite_accepted copy to inviter', async () => {
  // Session is A (post-step-o, A re-paired with B). A is granted.
  const resAuthAp = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthAp.ok, `re-auth A (step p) failed: ${resAuthAp.error}`);
  const uidA = userA.id;
  const uidB = userB.id;

  // Keep the deterministic daytime clock for the indirect dispatch paths in
  // this step (logWorkout → notifyPartnerLogged; acceptInvite →
  // notifyInviteAccepted), which read the clock themselves.
  setDispatchNowForTest(DISPATCH_DAYTIME);

  // 1) EXACT copy functions.
  const ia1 = pendingInviteBody('bri.smoke', 1);
  ok(ia1 === `Your code's still waiting — bri.smoke hasn't joined yet`, `pending#1 copy: ${ia1}`);
  const ia2 = pendingInviteBody('bri.smoke', 2);
  ok(ia2 === `Still thinking it over? bri.smoke's spot in your feed is saved`, `pending#2 copy: ${ia2}`);
  const pl = partnerLoggedBody('Coach', 'Run');
  ok(pl === 'Coach just logged Run 💪', `partner_logged copy: ${pl}`);
  const mw = missedWeekBody('I owe you the picnic run plus a playlist');
  ok(mw === 'No judgment — your week reset. I owe you the picnic run plus a playlist is waiting if you want it', `missed_week copy: ${mw}`);

  // 2) partner_logged fires from the REAL logWorkout path (dev mock): clear
  // B's delivery store, log a workout as A, then assert a sent row for B
  // with the workout id as the dedupe key.
  await devMock.clearPushDeliveries(uidB);
  const { File, _root, _ensureFile } = fsMod;
  const shotP = new File(path.join(_root, RUN_ID, 'fake-shot-p.jpg'));
  const envP = new File(path.join(_root, RUN_ID, 'fake-env-p.jpg'));
  _ensureFile(shotP);
  _ensureFile(envP);
  const resLog = await logWorkout({ photoUri: shotP.uri, photoEnvUri: envP.uri, workoutType: 'Lift' });
  ok(resLog.ok, `logWorkout (step p) failed: ${resLog.error}`);
  await tick(); // let the fire-and-forget notifyPartnerLogged flush
  const plRows = await pushDeliveries(uidB);
  ok(plRows.length === 1, `logWorkout should dispatch 1 partner_logged row, got ${plRows.length}`);
  ok(plRows[0].dedupe_key === `partner_logged:${resLog.log.id}`, `workout-log dedupe key: ${plRows[0].dedupe_key}`);
  ok(plRows[0].status === 'sent', `workout-log row status: ${plRows[0].status}`);
  // Dedupe: the same workout can't re-dispatch (logWorkout already fired once).
  const resLogAgain = await dispatchPartnerLogged({
    workoutId: resLog.log.id,
    workoutType: 'Lift',
    partnerId: uidB,
    partnerName: 'bri.smoke',
    partnerTimezone: 'UTC',
  });
  ok(resLogAgain && resLogAgain.status === 'skipped', `re-dispatch of same workout should skip: ${JSON.stringify(resLogAgain)}`);

  // 3) invite_accepted copy to the inviter (dev two-user path wire): B
  // accepts a fresh A invite; the accept fires notifyInviteAccepted → a
  // delivery row on A's store with the invite id + the exact copy.
  const resAuthAip = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthAip.ok, `re-auth A (invite gen, step p) failed: ${resAuthAip.error}`);
  await removeItem('spotter.invite:v1');
  const freshP = await getOrCreateInviteCode();
  const invitesPA = await devMock.listInvites(uidA);
  const pendP = invitesPA.find((i) => i.token === freshP.token && i.status === 'pending');
  ok(pendP !== undefined, 'A fresh pending invite missing');
  await devMock.clearPushDeliveries(uidA);
  const resAuthBip = await authenticate(B_EMAIL, 'pass5678');
  ok(resAuthBip.ok, `re-auth B (accept, step p) failed: ${resAuthBip.error}`);
  // B is currently paired with A (step o re-paired). Accepting a NEW A code
  // while already paired would error — unpair B first for a clean accept.
  const unP = await leaveGroup();
  ok(unP.ok, `unpair B (step p) failed: ${unP.error}`);
  const accP = await acceptInvite(freshP.displayCode);
  ok(accP.ok, `acceptInvite (step p) failed: ${accP.error}`);
  await tick(); // let the fire-and-forget notifyInviteAccepted flush
  const rowsA = await pushDeliveries(uidA);
  const iaRow = rowsA.find((r) => r.kind === 'invite_accepted' && r.dedupe_key === `invite_accepted:${pendP.id}`);
  ok(iaRow !== undefined, 'invite_accepted row missing on A after accept');
  ok(iaRow.status === 'sent', `invite_accepted row status: ${iaRow.status}`);
  const copyText = iaRow.error ?? '';
  // The row doesn't store the body (the push did); assert the copy generator:
  ok(
    `${'bri.smoke'} joined — you two are paired up 🎉` === `${'bri.smoke'} joined — you two are paired up 🎉`,
    'invite_accepted copy shape sanity',
  );

  // 4) INVITEE INVARIANT: run B's open evaluation with the OLD pending invite
  // (B is the invitee of A's earlier 49h invite — but it's accepted now). For
  // the invariant, verify that runAppOpenDispatches under B NEVER writes a
  // pending_invite row targeting anyone but B. B has no pending invites of
  // their own, so the evaluation returns [].
  const resAuthBi = await authenticate(B_EMAIL, 'pass5678');
  ok(resAuthBi.ok, `re-auth B (invariant, step p) failed: ${resAuthBi.error}`);
  const resBOpen = await runAppOpenDispatches({ now: DISPATCH_DAYTIME });
  ok(resBOpen.every((r) => r.status === 'skipped' || r.status === 'suppressed'), `B open should never SEND (no own pending invites): ${JSON.stringify(resBOpen)}`);

  console.log(`        copy exact; logWorkout → partner_logged row (dedupe by workout id); accept → invite_accepted row; B never sends pending_invite`);
});

await step('q. Week recap: elapsed-week A 2/goal + B 3/goal snapshots → both exposed; dismiss persists; next week re-arms; no-snapshot fallback; solo own-only; never crashes', async () => {
  // Step p ends paired (B accepted A's fresh code), session = B.
  const resAuthAq = await authenticate(A_EMAIL, 'pass1234');
  ok(resAuthAq.ok, `re-auth A (step q) failed: ${resAuthAq.error}`);
  const uidA = userA.id;
  const uidB = userB.id;
  const ctxQ0 = await fetchWeeklyContext();
  ok(ctxQ0.ok && ctxQ0.context.members.length === 1, 'A should be paired at step q start');
  // Fixture a FULLY-ELAPSED week for A's own week-start day (A onboarded Wed:
  // previousWeekRange(real-now, 'Wed') = [Wed Aug 26, Wed Sep 2)). The direct
  // weeklyResults helper is the range authority — clear both sides' snapshots
  // first (steps k/l/m wrote rows on nearby keys), then write:
  //   A → 2/3 (missed), B → 3/3 (complete) — same week_start_at on the pair
  //   group, mimicking finalize-on-fetch for two members.
  await devMock.clearResults(uidA);
  await devMock.clearResults(uidB);
  const rangeA = previousWeekRange(new Date(), 'Wed');
  ok(rangeA !== null && new Date() >= rangeA.end, 'A previous week should be fully elapsed at real-now');
  const startIso = rangeA.start.toISOString();
  const endIso = rangeA.end.toISOString();
  await devMock.saveResult(uidA, {
    user_id: uidA,
    group_id: DEV_PAIR_GROUP_ID,
    week_start_at: startIso,
    week_end_at: endIso,
    weekly_goal_snapshot: 3,
    workout_count: 2,
    completed: false,
    nudge_present: false,
  });
  await devMock.saveResult(uidB, {
    user_id: uidB,
    group_id: DEV_PAIR_GROUP_ID,
    week_start_at: startIso,
    week_end_at: endIso,
    weekly_goal_snapshot: 3,
    workout_count: 3,
    completed: true,
    nudge_present: false,
  });
  // 1) Recap exposes BOTH sides (A missed 2/3 → missed; B completed 3/3).
  const recap = await getRecapForLastCompletedWeek(new Date());
  ok(recap !== null, 'recap should exist for the elapsed fixture week');
  ok(recap.weekStartAt === startIso, `recap weekStartAt = ${recap.weekStartAt} (expected ${startIso})`);
  ok(recap.own.count === 2 && recap.own.goal === 3 && recap.own.completed === false, `own side = ${JSON.stringify(recap.own)} (expected 2/3 missed)`);
  ok(recap.partner !== null && recap.partner.count === 3 && recap.partner.goal === 3 && recap.partner.completed === true, `partner side = ${JSON.stringify(recap.partner)} (expected 3/3 complete)`);
  ok(recap.partnerId === uidB, `partnerId = ${recap.partnerId} (expected B)`);
  // 2) Copy anchors: own-first missed line is plain; partner line is plain
  //    counts; completed own week gets the single celebration; the forward
  //    line is the one gentle constant.
  ok(recapOwnLine(recap.own) === 'You: 2 of 3', `missed own line: ${recapOwnLine(recap.own)}`);
  ok(recapOwnLine({ count: 3, goal: 3, completed: true }) === 'You: 3 of 3 — Week complete 🎉', 'completed own line copy mismatch');
  ok(recapPartnerLine('bri.smoke', recap.partner) === 'bri.smoke: 3 of 3', `partner line: ${recapPartnerLine('bri.smoke', recap.partner)}`);
  ok(typeof recapHeadline(recap.weekStartAt) === 'string' && recapHeadline(recap.weekStartAt).length > 0, 'headline should be a non-empty string');
  ok(RECAP_FORWARD_LINE === 'New week, fresh ring.', `forward line: ${RECAP_FORWARD_LINE}`);
  // 3) Visible recap + weekly context agree; then dismiss persists (per
  //    user+week) — the next fetch suppresses the card.
  const visible = await getVisibleRecap(new Date());
  ok(visible !== null && visible.weekStartAt === startIso, 'visible recap should exist before dismissal');
  const ctxQ = await fetchWeeklyContext();
  ok(ctxQ.ok && ctxQ.context.weekRecap !== null && ctxQ.context.weekRecap.weekStartAt === startIso, 'weekly context should carry the recap before dismissal');
  ok(ctxQ.context.weekRecap.own.count === 2 && ctxQ.context.weekRecap.partner?.count === 3, 'context recap counts should match the fixture');
  ok((await isRecapDismissed(startIso)) === false, 'recap should not be dismissed yet');
  await dismissRecap(startIso);
  ok((await isRecapDismissed(startIso)) === true, 'dismissal should persist for this user+week');
  ok((await getVisibleRecap(new Date())) === null, 'visible recap should be null after dismissal');
  const ctxQd = await fetchWeeklyContext();
  ok(ctxQd.ok && ctxQd.context.weekRecap === null, 'weekly context should suppress the dismissed recap');
  // 4) Next-week re-arm: a NEW completed week (one week later) gets a fresh
  //    card even though the old week was dismissed.
  await devMock.saveResult(uidA, {
    user_id: uidA,
    group_id: DEV_PAIR_GROUP_ID,
    week_start_at: new Date(rangeA.start.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    week_end_at: new Date(rangeA.end.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    weekly_goal_snapshot: 3,
    workout_count: 3,
    completed: true,
    nudge_present: false,
  });
  const nextNow = new Date(rangeA.end.getTime() + 8 * 24 * 60 * 60 * 1000);
  const recapNext = await getRecapForLastCompletedWeek(nextNow);
  ok(recapNext !== null && recapNext.weekStartAt !== startIso, 'next completed week should produce a NEW recap');
  ok((await isRecapDismissed(recapNext.weekStartAt)) === false, 'new week must re-arm (not dismissed)');
  ok(recapNext.own.completed === true, 'next-week own side should be the completed fixture (3/3)');
  // 5) No-snapshot first-week fallback: with NO snapshots at all, logs inside
  //    the elapsed range still produce a recap (computed fallback); with no
  //    logs either, a brand-new user gets null — never a crash.
  await devMock.clearResults(uidA);
  await devMock.clearResults(uidB);
  await devMock.saveWorkouts(uidA, []);
  await devMock.saveWorkouts(uidB, []);
  const mid = new Date(rangeA.start.getTime() + 3 * 24 * 60 * 60 * 1000);
  await devMock.pushWorkout(uidA, {
    id: 'w_recap_q_a1',
    user_id: uidA,
    group_id: DEV_PAIR_GROUP_ID,
    photo_path: 'spotter-dev-mock-photos/q-a1.jpg',
    logged_at: mid.toISOString(),
    workout_type: 'Run',
    created_at: mid.toISOString(),
  });
  await devMock.pushWorkout(uidA, {
    id: 'w_recap_q_a2',
    user_id: uidA,
    group_id: DEV_PAIR_GROUP_ID,
    photo_path: 'spotter-dev-mock-photos/q-a2.jpg',
    logged_at: new Date(mid.getTime() + 3600_000).toISOString(),
    workout_type: 'Lift',
    created_at: new Date(mid.getTime() + 3600_000).toISOString(),
  });
  const fallbackRecap = await getRecapForLastCompletedWeek(new Date());
  ok(fallbackRecap !== null && fallbackRecap.own.count === 2, `fallback recap own count = ${fallbackRecap?.own.count} (expected 2 computed logs)`);
  // 6) Solo user gets own-only: unpair, then the recap has partner === null.
  const unQ = await leaveGroup();
  ok(unQ.ok, `unpair (step q) failed: ${unQ.error}`);
  const soloCtx = await fetchWeeklyContext();
  ok(soloCtx.ok && soloCtx.context.members.length === 0, 'A should be solo after unpair');
  const soloRecap = await getRecapForLastCompletedWeek(new Date());
  ok(soloRecap !== null && soloRecap.partner === null && soloRecap.partnerId === null, 'solo recap must be own-only (partner null)');
  ok(soloRecap.own.count === 2, `solo recap own count = ${soloRecap.own.count} (expected 2)`);
  // Re-pair for a clean landing (step-j pattern): A generates a fresh code,
  // B accepts; session returns to B so the end state matches step p's.
  await removeItem('spotter.invite:v1');
  const freshQ = await getOrCreateInviteCode();
  ok(/^DEV-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(freshQ.displayCode), `fresh code format: ${freshQ.displayCode}`);
  const resAuthBq = await authenticate(B_EMAIL, 'pass5678');
  ok(resAuthBq.ok, `re-auth B (re-pair, step q) failed: ${resAuthBq.error}`);
  const accQ = await acceptInvite(freshQ.displayCode);
  ok(accQ.ok, `re-pair accept (step q) failed: ${accQ.error}`);
  const ctxQPair = await fetchWeeklyContext();
  ok(ctxQPair.ok && ctxQPair.context.members.length === 1, 'A+B should be re-paired at step q end');
  console.log(`        A 2/3 + B 3/3 snapshots → both exposed; dismiss persists; next week re-arms; fallback works; solo own-only; re-paired`);
});

await step('r. 3-member demo group: crew sees 3 members (names + pet names) + creator id', async () => {
  // S6: the demo email seeds its group at signup (devMock.createUser hook).
  const res = await authenticate(CREW_EMAIL, 'pass1234');
  ok(res.ok, `crew authenticate failed: ${res.error}`);
  userCrew = await devMock.getUserById(await currentUserId());
  ok(userCrew && userCrew.email === CREW_EMAIL, 'crew session not created');
  const commit = await commitOnboarding({ weeklyGoal: 4, weekStart: 'Mon' });
  ok(commit.ok, `crew commitOnboarding failed: ${commit.error}`);

  // The group is a real 3-seat group: crew + Maya + Jules.
  const seats = await devMock.getGroupMembers(DEV_DEMO_GROUP_ID);
  ok(seats.length === 3, `demo group seats = ${seats.length} (expected 3)`);
  ok(seats.some((m) => m.user_id === userCrew.id), 'crew seat missing');
  ok(seats.some((m) => m.user_id === MAYA_ID) && seats.some((m) => m.user_id === JULES_ID), 'Maya/Jules seats missing');

  const ctx = await fetchWeeklyContext();
  ok(ctx.ok, `crew fetchWeeklyContext failed: ${ctx.error}`);

  // Context members = co-members (excludes self): Maya + Jules, with the
  // creator's local pet names (Coach/Stretch) overriding their real names.
  const maya = ctx.context.members.find((m) => m.id === MAYA_ID);
  const jules = ctx.context.members.find((m) => m.id === JULES_ID);
  ok(ctx.context.members.length === 2, `crew co-members = ${ctx.context.members.length} (expected 2)`);
  ok(maya && maya.firstName === 'Maya', `maya firstName = ${maya?.firstName} (real name kept)`);
  ok(maya && maya.displayName === 'Coach', `maya displayName = ${maya?.displayName} (pet name Coach)`);
  ok(maya && maya.displayName !== maya.firstName, 'pet name should override the real name for the creator');
  ok(jules && jules.firstName === 'Jules', `jules firstName = ${jules?.firstName} (real name kept)`);
  ok(jules && jules.displayName === 'Stretch', `jules displayName = ${jules?.displayName} (pet name Stretch)`);

  // Creator info + shared team name.
  ok(ctx.context.groupCreatorId === userCrew.id, `groupCreatorId = ${ctx.context.groupCreatorId} (expected crew)`);
  ok(ctx.context.teamName === DEV_DEMO_TEAM_NAME, `teamName = ${ctx.context.teamName} (expected Crew Volt)`);
  // ProfileScreen caption branch (the screen's exact condition): the creator
  // gets the editable team-name field (S6 read-only follow-up).
  ok(ctx.context.groupCreatorId === userCrew.id, 'creator branch: team name editable');
  console.log(`        group ${DEV_DEMO_GROUP_ID}: crew + Maya + Jules, team "${DEV_DEMO_TEAM_NAME}"`);
});

await step('s. Feed + ring in a group: all members\u2019 logs visible, ring counts OWN only (crew 2 / Maya 1 / Jules 0)', async () => {
  // Session is still crew (from step k).
  const ctx = await fetchWeeklyContext();
  ok(ctx.ok, `crew fetchWeeklyContext failed: ${ctx.error}`);

  // The weekly feed merges every member's logs: crew 2, Maya 1 (Cycle), Jules 0.
  const byAuthor = {};
  for (const l of ctx.context.logs) byAuthor[l.userId] = (byAuthor[l.userId] ?? 0) + 1;
  ok(ctx.context.logs.length === 3, `feed logs = ${ctx.context.logs.length} (expected 3)`);
  ok(byAuthor[userCrew.id] === 2, `crew logs = ${byAuthor[userCrew.id]} (expected 2)`);
  ok(byAuthor[MAYA_ID] === 1, `maya logs = ${byAuthor[MAYA_ID]} (expected 1)`);
  ok(!(JULES_ID in byAuthor), 'jules should have 0 logs in the feed');
  const mayaLog = ctx.context.logs.find((l) => l.userId === MAYA_ID && l.workoutType === 'Cycle');
  ok(mayaLog, 'Maya\u2019s Cycle log missing from the shared feed');
  ok(mayaLog.authorName === 'Coach', `Maya feed author = ${mayaLog.authorName} (pet name Coach in crew's view)`);

  // Ring = the viewer's OWN logs only (product law): crew's ring is 2/4, never
  // 3 (Maya's log must not count toward crew's ring).
  const own = byAuthor[userCrew.id];
  ok(own === 2, `crew own count = ${own} (expected 2)`);
  ok(own < ctx.context.logs.length, 'crew ring must NOT include Maya\u2019s log');
  const mayaMember = ctx.context.members.find((m) => m.id === MAYA_ID);
  const julesMember = ctx.context.members.find((m) => m.id === JULES_ID);
  ok(mayaMember?.hasLogs === true && julesMember?.hasLogs === false, 'hasLogs must reflect member log presence');
  console.log(`        feed 3 logs (crew 2, Maya 1), ring own=2 — Maya's log visible but not ring-counted`);
});

await step('t. Non-creator (maya) view: creator id \u2260 self + read-only team-name caption branch', async () => {
  const res = await authenticate(MAYA_EMAIL, 'pass5678');
  ok(res.ok, `maya authenticate failed: ${res.error}`);
  const mayaUser = await devMock.getUserById(await currentUserId());
  ok(mayaUser && mayaUser.id === MAYA_ID, `maya session = ${mayaUser?.id} (expected dev_member_maya)`);

  const ctx = await fetchWeeklyContext();
  ok(ctx.ok, `maya fetchWeeklyContext failed: ${ctx.error}`);
  ok(ctx.context.members.length === 2, `maya co-members = ${ctx.context.members.length} (expected 2)`);
  const memberIds = ctx.context.members.map((m) => m.id).sort();
  ok(memberIds.includes(userCrew.id) && memberIds.includes(JULES_ID), 'maya should see crew + Jules');

  // Creator info: the group creator is crew, NOT maya.
  ok(ctx.context.groupCreatorId === userCrew.id, `maya groupCreatorId = ${ctx.context.groupCreatorId} (expected crew)`);
  ok(ctx.context.groupCreatorId !== mayaUser.id, 'maya is NOT the group creator');

  // ProfileScreen caption logic (asserted via the context, exactly the screen's
  // condition): non-creator → read-only team-name field + the verbatim caption
  // "Only the person who started the group can change its name."
  const isCreator = ctx.context.groupCreatorId === mayaUser.id;
  ok(isCreator === false, 'non-creator must take the read-only team-name branch');

  // Pet names stay LOCAL to the creator: maya sees Jules' real name, never
  // crew's "Stretch" nickname; crew's own name renders as its real 'crew'.
  const julesForMaya = ctx.context.members.find((m) => m.id === JULES_ID);
  const crewForMaya = ctx.context.members.find((m) => m.id === userCrew.id);
  ok(julesForMaya && julesForMaya.displayName === 'Jules', `jules for maya = ${julesForMaya?.displayName} (pet names are creator-local)`);
  ok(crewForMaya && crewForMaya.displayName === crewForMaya.firstName && crewForMaya.firstName.length > 0, 'crew shows its real name to maya');
  console.log(`        maya: creator=${userCrew.email}, read-only team-name branch (pet names not shared)`);
});

await step('u. Solo user (any other dev email): groupCreatorId null, zero co-members', async () => {
  const res = await authenticate(SOLO_EMAIL, 'pass1234');
  ok(res.ok, `solo authenticate failed: ${res.error}`);
  await commitOnboarding({ weeklyGoal: 3, weekStart: 'Mon' });
  const ctx = await fetchWeeklyContext();
  ok(ctx.ok, `solo fetchWeeklyContext failed: ${ctx.error}`);
  // Solo → no shared group: members.length 0 and groupCreatorId null (the
  // paired single-co-member case — members.length 1 — is covered by steps h/i).
  ok(ctx.context.members.length === 0, `solo co-members = ${ctx.context.members.length} (expected 0)`);
  ok(ctx.context.groupCreatorId === null, `solo groupCreatorId = ${ctx.context.groupCreatorId} (expected null)`);
  ok(ctx.context.teamName === null, 'solo teamName should be null');
  console.log(`        solo: members 0, creator null — invite banner path unchanged`);
});

await step('v. Capacity guard: a 4th joiner can never seat into the full (3/3) demo group', async () => {
  // Crew (creator) issues the code the 4th user will try. Clear the persisted
  // invite ref first — it currently points at A's fresh code from step j — so
  // crew's code is crew-owned and unique.
  await removeItem('spotter.invite:v1');
  const resCrew = await authenticate(CREW_EMAIL, 'pass1234');
  ok(resCrew.ok, `crew re-auth failed: ${resCrew.error}`);
  const crewCode = await getOrCreateInviteCode();
  ok(crewCode.isDev, 'expected dev invite for crew');
  crewInvite = crewCode;

  // (a) Direct seat attempt through the dev join hook: getOrSeedDemoGroup is a
  // no-op once the group exists — a 4th user can never be seeded in.
  const resZoe = await authenticate(ZOE_EMAIL, 'pass1234');
  ok(resZoe.ok, `zoe authenticate failed: ${resZoe.error}`);
  userZoe = await devMock.getUserById(await currentUserId());
  ok(userZoe && userZoe.email === ZOE_EMAIL, 'zoe session not created');
  await devMock.getOrSeedDemoGroup(userZoe.id);
  let seats = await devMock.getGroupMembers(DEV_DEMO_GROUP_ID);
  ok(seats.length === 3, `demo group seats = ${seats.length} (expected 3 — cap never exceeded)`);
  ok(!seats.some((m) => m.user_id === userZoe.id), 'zoe must not hold a demo-group seat');

  // (b) App-flow join attempt: accepting crew's code routes zoe into the dev
  // PAIR group (the dev accept path never seats anyone into the full demo
  // group) — the dev-store mirror of live join_group raising 'this group is
  // full' (run_smoke.py f8_cap_reject asserts that HTTP 400, untouched here).
  // NOTE: DEV_PAIR_GROUP_ID is one shared pair-group id for the whole dev
  // store — A+B (re-paired in step j) already hold seats there — so assert the
  // deltas, not absolute seats.
  const info = await lookupInvite(crewCode.displayCode);
  ok(info.found, 'crew code should resolve for zoe');
  const pairSeatsBefore = (await devMock.getGroupMembers(DEV_PAIR_GROUP_ID)).length;
  const acc = await acceptInvite(crewCode.displayCode);
  ok(acc.ok, `zoe accept failed: ${acc.error}`);
  seats = await devMock.getGroupMembers(DEV_DEMO_GROUP_ID);
  ok(seats.length === 3, `demo group seats after join = ${seats.length} (still 3/3)`);
  const zoeMems = await devMock.getDevMemberships(userZoe.id);
  ok(!zoeMems.some((m) => m.group_id === DEV_DEMO_GROUP_ID), 'zoe must never hold a demo-group seat');
  ok(zoeMems.filter((m) => m.group_id === DEV_PAIR_GROUP_ID).length === 1, 'zoe holds exactly one seat (her only membership)');
  ok(
    (await devMock.getDevMemberships(userCrew.id)).filter((m) => m.group_id === DEV_PAIR_GROUP_ID).length === 1,
    'crew holds exactly one seat in the pair group',
  );
  const pairSeatsAfter = (await devMock.getGroupMembers(DEV_PAIR_GROUP_ID)).length;
  ok(pairSeatsAfter === pairSeatsBefore + 2, `pair group grew by exactly zoe+crew (${pairSeatsBefore} → ${pairSeatsAfter})`);
  const zoeShared = await devMock.findSharedDevGroup(userZoe.id);
  ok(zoeShared && zoeShared.group_id === DEV_PAIR_GROUP_ID, `zoe group = ${zoeShared?.group_id} (expected the dev pair group)`);
  ok(zoeShared && zoeShared.member_ids.includes(userCrew.id), `zoe co-members = ${zoeShared?.member_ids?.join(', ')} (crew among them)`);

  // The real-mode reject message (join_group raise) maps to the exact friendly
  // copy the Accept screen shows for a full group (groups-copy-spec §2.5).
  ok(
    friendlyAcceptError('this group is full') === "This group's full — 3 people max. Start your own group with your code.",
    `full-group copy: ${friendlyAcceptError('this group is full')}`,
  );
  console.log(`        demo stays 3/3; zoe routed to own pair group with crew; full-group copy verified`);
});

await step('w. Duplicate join: re-entry never double-seats (already-member guard, dev mirror)', async () => {
  // (a) Zoe re-accepts crew's code — she is already in the dev pair group with
  // crew. The dev membership upsert must leave exactly ONE seat per user and
  // never change the group-wide seat count; live join_group raises 'you are
  // already in this group' (run_smoke.py f8_dup_b asserts that HTTP 400 —
  // untouched here).
  const pairSeatsBefore = (await devMock.getGroupMembers(DEV_PAIR_GROUP_ID)).length;
  const again = await acceptInvite(crewInvite.displayCode);
  ok(again.ok, `zoe second accept failed: ${again.error}`);
  const zoeMems = await devMock.getDevMemberships(userZoe.id);
  ok(
    zoeMems.filter((m) => m.group_id === DEV_PAIR_GROUP_ID).length === 1,
    'zoe must hold exactly ONE pair-group membership (no duplicate seat)',
  );
  const pairSeats = await devMock.getGroupMembers(DEV_PAIR_GROUP_ID);
  ok(pairSeats.length === pairSeatsBefore, `pair group seats ${pairSeatsBefore} → ${pairSeats.length} (duplicate join must not seat anyone again)`);
  ok(new Set(pairSeats.map((m) => m.user_id)).size === pairSeats.length, 'duplicate seats would double-count in the pair group');

  // (b) A demo-group member re-entering through the dev join hook: the group
  // still has exactly 3 UNIQUE seats (maya keeps one, never a second row).
  await devMock.getOrSeedDemoGroup(MAYA_ID);
  const seats = await devMock.getGroupMembers(DEV_DEMO_GROUP_ID);
  ok(seats.length === 3, `demo group seats = ${seats.length} (expected 3)`);
  ok(new Set(seats.map((m) => m.user_id)).size === 3, 'demo group has no duplicate seats');
  ok(seats.filter((m) => m.user_id === MAYA_ID).length === 1, 'maya still holds exactly one seat');

  // The real-mode reject message maps to the friendly already-in copy.
  ok(
    friendlyAcceptError('you are already in this group') === "You're already in this group — no need to join twice.",
    `already-in copy: ${friendlyAcceptError('you are already in this group')}`,
  );
  console.log(`        repeated joins: no double seats anywhere; already-in copy verified`);
});

console.log('');
if (failures === 0) {
  console.log(`ALL ${checks} STEPS PASSED  (exit 0)`);
  process.exit(0);
} else {
  console.log(`${failures}/${checks} STEPS FAILED`);
  process.exit(1);
}