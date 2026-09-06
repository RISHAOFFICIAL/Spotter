#!/usr/bin/env node
/**
 * SPOTTER MVP end-to-end two-user smoke test (dev-mock mode).
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
const { setPrefix, clearAll, removeItem } = require(path.join(__dirname, 'smoke', 'async-storage.js'));
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
};
const { devMock, DEV_PAIR_GROUP_ID } = model.mock;
const { authenticate, getStoredSession } = model.supabase;
const { fetchWeeklyContext, logWorkout } = model.workoutStore;
const { getOrCreateInviteCode, lookupInvite, acceptInvite, unpair } = model.invites;
const { commitOnboarding } = model.settings;
const { setPetName, getPetName, setTeamName } = model.naming;

console.log(`SPOTTER MVP two-user smoke test (dev mock)  [${RUN_ID}]`);
console.log('');

const A_EMAIL = 'alex.smoke@spotter.test';
const B_EMAIL = 'bri.smoke@spotter.test';
let userA, userB, invite;

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

await step('c. A logs a workout (photo path scoped per user)', async () => {
  const { File, _root, _ensureFile } = fsMod;
  const shot = new File(path.join(_root, RUN_ID, 'fake-shot-a.jpg'));
  _ensureFile(shot);
  const res = await logWorkout({ photoUri: shot.uri, workoutType: 'Run' });
  ok(res.ok, `logWorkout failed: ${res.error}`);
  const log = res.log;
  ok(log && log.userId === userA.id, 'log author not A');
  ok(log.photoPath.includes('spotter-dev-mock-photos') && log.photoPath.includes(userA.id), `photo not per-user scoped: ${log.photoPath}`);
  console.log(`        log ${log.id} photo path: ${log.photoPath}`);
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
  _ensureFile(shot);
  const res = await logWorkout({ photoUri: shot.uri, workoutType: 'Lift' });
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

await step('h. Solo-mode invite banner state flips to paired after accept', async () => {
  const ctx = await fetchWeeklyContext();
  ok(ctx.context.hasPartner === true, 'hasPartner still false');
  ok(ctx.context.partner?.id === userB.id, `partner = ${ctx.context.partner?.id}`);
  // home-screen.md §3: the banner renders only when hasPartner === false, so
  // the context flip is exactly what unmounts the banner.
  console.log(`        hasPartner=true, partner=${ctx.context.partner?.firstName}`);
});

await step('i. Naming: pet name overrides partner label locally; team name shared on pair group', async () => {
  // Session is A (re-authed in step g). A's partner is B (bri.smoke).
  // A) Pet name (local-only): what A calls B, shown to A only.
  await setPetName('Coach');
  ok((await getPetName()) === 'Coach', 'pet name did not persist');

  let ctx = await fetchWeeklyContext();
  ok(ctx.context.partnerDisplayName === 'Coach', `partnerDisplayName=${ctx.context.partnerDisplayName} (expected Coach)`);
  ok(ctx.context.partner?.firstName === 'bri.smoke', 'partner.firstName must stay the REAL name');
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

  // Fallback: clearing the pet name returns partner label to the real name.
  await setPetName('');
  ctx = await fetchWeeklyContext();
  ok(ctx.context.partnerDisplayName === 'bri.smoke', `cleared pet name → ${ctx.context.partnerDisplayName} (expected bri.smoke)`);
  ok(ctx.context.teamName === 'Team Us', 'team name should persist after clearing pet name');

  // Local-only isolation: B does NOT see A's pet name, but DOES see the team name.
  const resB = await authenticate(B_EMAIL, 'pass5678');
  ok(resB.ok, `re-auth B failed: ${resB.error}`);
  const ctxB = await fetchWeeklyContext();
  ok(ctxB.context.partnerDisplayName === 'alex.smoke', `B partnerDisplayName=${ctxB.context.partnerDisplayName} (expected alex.smoke — no pet name set for B)`);
  ok(ctxB.context.teamName === 'Team Us', `B teamName=${ctxB.context.teamName} (expected shared Team Us)`);

  // Restore session A + clear the team name so a re-run starts clean.
  await authenticate(A_EMAIL, 'pass1234');
  await setTeamName('');
  console.log(`        pet name "Coach" → local override; team "Team Us" → shared header`);
});

await step('j. Unpair: both sides return to solo, own logs intact, re-pair works with a fresh code', async () => {
  // Session is A (restored at the end of step i). A and B are paired; A has
  // its own log (step c), B has its own (step f). Clear A's local pet-name
  // override so the solo→pair→unpair assertions read real names only.
  await setPetName('');

  // Confirm A still sees the pair before unpairing (sanity baseline).
  let ctx = await fetchWeeklyContext();
  ok(ctx.context.hasPartner === true, 'A should be paired before unpair');
  const aLogsBefore = await devMock.listWorkouts(userA.id);
  const bLogsBefore = await devMock.listWorkouts(userB.id);
  ok(aLogsBefore.length === 1, `A logs before unpair = ${aLogsBefore.length} (expected 1)`);
  ok(bLogsBefore.length === 1, `B logs before unpair = ${bLogsBefore.length} (expected 1)`);

  // Unpair as A.
  const res = await unpair();
  ok(res.ok, `unpair failed: ${res.error}`);

  // A is solo: hasPartner=false, no pair memberships, partner state reset.
  ctx = await fetchWeeklyContext();
  ok(ctx.context.hasPartner === false, 'A hasPartner should be false after unpair');
  ok(ctx.context.partner === null, 'A partner should be null after unpair');
  const memA = await devMock.getDevMemberships(userA.id);
  ok(!memA.some((m) => m.group_id === DEV_PAIR_GROUP_ID), 'A pair membership not removed');

  // B is solo too (both memberships of the pair group deleted).
  const memB = await devMock.getDevMemberships(userB.id);
  ok(!memB.some((m) => m.group_id === DEV_PAIR_GROUP_ID), 'B pair membership not removed');
  const stateB = await devMock.getPairState(userB.id);
  ok(stateB.accepted === false && stateB.partner === null, 'B pair state not reset to solo');

  // Own workout logs survive (photos stay per-user isolated); team name cleared.
  ok((await devMock.listWorkouts(userA.id)).length === 1, 'A logs lost after unpair');
  ok((await devMock.listWorkouts(userB.id)).length === 1, 'B logs lost after unpair');
  ok((await devMock.getTeamName()) === null, 'shared team name should clear on unpair');

  // Idempotent: unpairing again when already solo is a harmless no-op.
  const res2 = await unpair();
  ok(res2.ok, `second unpair should be a no-op ok: ${res2.error}`);

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
  ok(ctxA.context.hasPartner === true, 'A should be re-paired after fresh accept');
  ok(ctxA.context.partner?.id === userB.id, `A partner after re-pair = ${ctxA.context.partner?.id}`);

  console.log(`        A+B unpair → both solo, logs kept, fresh-code re-pair works`);
});

console.log('');
if (failures === 0) {
  console.log(`ALL ${checks} STEPS PASSED  (exit 0)`);
  process.exit(0);
} else {
  console.log(`${failures}/${checks} STEPS FAILED`);
  process.exit(1);
}