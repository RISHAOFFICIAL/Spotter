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
const { devMock, DEV_PAIR_GROUP_ID, DEV_DEMO_GROUP_ID, DEV_DEMO_TEAM_NAME } = model.mock;
const { authenticate, getStoredSession } = model.supabase;
const { fetchWeeklyContext, logWorkout } = model.workoutStore;
const { getOrCreateInviteCode, lookupInvite, acceptInvite, leaveGroup, friendlyAcceptError } = model.invites;
const { commitOnboarding } = model.settings;
const { setPetName, getPetName, setTeamName } = model.naming;

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

await step('k. 3-member demo group: crew sees 3 members (names + pet names) + creator id', async () => {
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

await step('l. Feed + ring in a group: all members\u2019 logs visible, ring counts OWN only (crew 2 / Maya 1 / Jules 0)', async () => {
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

await step('m. Non-creator (maya) view: creator id \u2260 self + read-only team-name caption branch', async () => {
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

await step('n. Solo user (any other dev email): groupCreatorId null, zero co-members', async () => {
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

await step('o. Capacity guard: a 4th joiner can never seat into the full (3/3) demo group', async () => {
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

await step('p. Duplicate join: re-entry never double-seats (already-member guard, dev mirror)', async () => {
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