#!/usr/bin/env node
/*
 * promise-rollover-guard — the offline check that proves the MISSED-GOAL
 * ROLLOVER actually reaches the Promises ledger.
 *
 * WHY IT EXISTS: `record_missed_promise` (schema.sql) and its client wrapper
 * (`src/lib/promises.ts → recordMissedPromise`) shipped without a single
 * production caller, so the ledger stayed empty forever while the listing
 * promised a pair-private promise on a missed week. The unit tests that DID
 * exist called the RPC directly — they proved the function worked and proved
 * nothing about whether the app ever called it. This guard drives the REAL
 * wiring instead: session → onboarding → pair → `fetchWeeklyContext()`
 * (the actual rollover point in src/lib/workoutStore.ts) → `fetchLedger()`.
 *
 * WHAT IT PROVES
 *  1. A completed week that MISSED the goal, with a promise set, produces
 *     exactly ONE Open ledger entry (maker, witness, text and week checked).
 *  2. Reopening the app after the week ends does NOT double-fire: repeat
 *     context fetches change nothing and do NOT call the RPC again.
 *  3. If the local once-flag is lost (fresh install / second device /
 *     concurrent fetches) the RPC runs again and the SERVER's idempotency
 *     still leaves exactly one entry.
 *  4. A completed missed week with NO note records nothing (never shaming),
 *     and still does not hammer the RPC on later opens.
 *  5. A week that MET the goal records nothing and never even asks the server.
 *  6. The new entry stays PAIR-PRIVATE inside a larger group: the named witness
 *     sees it, a non-witness co-member does not.
 *  7. Nothing in the ledger path widened RLS: `promise_entries` still carries
 *     exactly its one pair-column SELECT policy and no write policy, and the
 *     new client module reaches the table only through the RPC.
 *  8. A completed week that STARTED BEFORE the member joined their group (or
 *     began mid-week for them) records NOTHING — no false miss, no RPC call.
 *     The membership start is the signal, so the earlier scenarios explicitly
 *     backdate their memberships: they model members who were present for the
 *     WHOLE completed week (the dev store stamps new joins at real-now).
 *
 * NOT covered here (stated so no one reads more into a green run): real-mode
 * (Supabase) execution, push delivery, and the on-device UI. The dev mock
 * mirrors the real RPC semantics (same trim/≤80/witness re-validation/
 * UNIQUE-idempotency rules), and `scripts/real-mode-smoke/run_smoke.py`
 * exercises the real RPC against the live project.
 *
 * RUN:  node scripts/smoke/promise-rollover-guard.cjs   (exit 1 on any FAIL)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA = path.join(ROOT, 'supabase', 'schema.sql');
const ROLLOVER_SRC = path.join(ROOT, 'src', 'lib', 'promiseRollover.ts');
const COMPILED = path.join(ROOT, 'scripts', 'smoke', '.compiled');

// --------------------------------------------------------------------------
// tiny reporter (one PASS/FAIL line per check — run_smoke.py counts them)
// --------------------------------------------------------------------------
let passes = 0;
let fails = 0;
function check(name, ok, detail) {
  if (ok) passes += 1;
  else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

// --------------------------------------------------------------------------
// 1. compile the real lib modules (same step scripts/smoke-test.mjs runs)
// --------------------------------------------------------------------------
const compile = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'smoke', 'compile.cjs')], {
  encoding: 'utf8',
});
check(
  'harness: the app lib modules compile to CJS',
  compile.status === 0,
  (compile.stdout || '').trim() || (compile.stderr || '').trim().split('\n')[0] || `exit ${compile.status}`,
);
if (compile.status !== 0) {
  console.error(compile.stderr || compile.stdout);
  console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL`);
  process.exit(1);
}

// --------------------------------------------------------------------------
// 2. module stubs + require map (identical mechanism to scripts/smoke-test.mjs)
//    Modules are required in the APP's own order: workoutStore first (it pulls
//    in promiseRollover → promises → workoutStore, the one import cycle), so a
//    cycle that broke module evaluation would break HERE, not only on device.
// --------------------------------------------------------------------------
const { map } = require(path.join(COMPILED, '_deps.json'));
const storage = require(path.join(ROOT, 'scripts', 'smoke', 'async-storage.js'));
const fsMod = require(path.join(ROOT, 'scripts', 'smoke', 'expo-file-system.js'));
const RUN_ID = `rollover-${Date.now().toString(36)}`;
storage.setPrefix(RUN_ID);
storage.clearAll();
fsMod._clean(RUN_ID);
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (Object.prototype.hasOwnProperty.call(map, request)) return path.resolve(ROOT, 'scripts', map[request]);
  return origResolve.call(this, request, ...args);
};

let model;
try {
  model = {
    mock: require(path.join(COMPILED, 'mock.js')),
    supabase: require(path.join(COMPILED, 'supabase.js')),
    workoutStore: require(path.join(COMPILED, 'workoutStore.js')),
    invites: require(path.join(COMPILED, 'invites.js')),
    settings: require(path.join(COMPILED, 'settings.js')),
    weeklyResults: require(path.join(COMPILED, 'weeklyResults.js')),
    missPromise: require(path.join(COMPILED, 'missPromise.js')),
    promises: require(path.join(COMPILED, 'promises.js')),
    promiseRollover: require(path.join(COMPILED, 'promiseRollover.js')),
  };
  check('harness: real lib modules loaded in the app order (import cycle included)', true, 'workoutStore → promiseRollover → promises');
} catch (error) {
  check('harness: real lib modules loaded in the app order (import cycle included)', false, `${error.name}: ${error.message}`);
}

// RPC spy: the wiring must reach the RPC through the module export (that is what
// app code does), so patching the export counts every call the wiring makes.
let rpcCalls = [];
if (model) {
  const original = model.promises.recordMissedPromise;
  model.promises.recordMissedPromise = async (weekStart) => {
    rpcCalls.push(weekStart);
    return original(weekStart);
  };
}
const rpcCount = () => rpcCalls.length;

const { devMock, DEV_DEMO_GROUP_ID } = model ? model.mock : {};
const { authenticate, getStoredSession } = model ? model.supabase : {};
const { fetchWeeklyContext } = model ? model.workoutStore : {};
const { getOrCreateInviteCode, acceptInvite } = model ? model.invites : {};
const { commitOnboarding } = model ? model.settings : {};
const { previousWeekRange } = model ? model.weeklyResults : {};
const { setMissNote } = model ? model.missPromise : {};
const { fetchLedger } = model ? model.promises : {};
const rollover = model ? model.promiseRollover : {};

const MON = 'Mon';
const GOAL = 3;
const nowUtc = () => new Date();
/** The week `weeksAgo` back relative to the injected clock (0 = the last fully-elapsed week). */
const elapsedWeekStart = (weeksAgo = 0, at = new Date()) => {
  const r = previousWeekRange(at, MON);
  const start = new Date(r.start);
  start.setDate(start.getDate() - 7 * weeksAgo);
  return start;
};
/** A clock instant INSIDE the week that follows `week` — i.e. the moment at
 * which `week` is the most recent fully-elapsed one. */
const clockAfter = (week, offsetMs = 6 * 3600_000) => new Date(week.getTime() + 7 * 24 * 3600_000 + offsetMs);
/** "This member joined their group N weeks ago" (dev memberships are stamped at
 * real-now by the pair / demo seeding). */
const joinedWeeksAgo = (weeks) => Date.now() - weeks * 7 * 24 * 3600_000;
/** Stamp every membership row of the user's CURRENT shared dev group with a
 * join time, oldest member first (the dev mirror of memberships.created_at).
 * Scenarios that claim "a member missed a completed week" need their members to
 * have joined BEFORE that week — otherwise they are modelling a brand-new
 * joiner, which is precisely case 8 below. */
async function stampSharedGroupJoinedAt(userId, baseMs) {
  const shared = await devMock.findSharedDevGroup(userId);
  if (!shared) throw new Error(`no shared dev group for ${userId}`);
  let t = baseMs;
  for (const m of shared.members) {
    await devMock.addDevMembership({ ...m, created_at: new Date(t).toISOString() });
    t += 60_000; // keep a defined join order
  }
}
/** Re-stamp one user's own membership row in a group (the guard's stand-in for
 * "this is when I joined"). */
async function stampMyMembership(userId, groupId, iso) {
  const rows = await devMock.getDevMemberships(userId);
  const mine = rows.find((m) => m.group_id === groupId);
  if (!mine) throw new Error(`no membership row for ${userId} in ${groupId}`);
  await devMock.addDevMembership({ ...mine, created_at: iso });
}
const workRow = (userId, loggedAtIso) => ({
  id: `row-${Math.random().toString(36).slice(2, 10)}`,
  user_id: userId,
  group_id: 'dev-pair-group',
  photo_path: 'mock://rollover/selfie.jpg',
  photo_env: 'mock://rollover/env.jpg',
  caption: null,
  logged_at: loggedAtIso,
  workout_type: null,
  created_at: loggedAtIso,
});

/** Sign in as a fresh user (optionally onboarding: goal 3, week starts Mon). */
async function freshUser(email, onboard = true) {
  const res = await authenticate(email, 'pass1234');
  if (!res || !res.ok) throw new Error(`authenticate(${email}) failed: ${res && res.error}`);
  const id = (await getStoredSession()).user.id;
  if (onboard) {
    const onb = await commitOnboarding({ weeklyGoal: GOAL, weekStart: MON });
    if (!onb || !onb.ok) throw new Error(`commitOnboarding(${email}) failed: ${onb && onb.error}`);
  }
  return id;
}

/** Pair `makerEmail` with `partnerEmail` (witness) — the smoke suite's proven
 * flow: maker onboards + creates the code, invitee accepts, maker signs back in. */
async function pairWith(makerEmail, partnerEmail) {
  await freshUser(makerEmail);
  // A fresh install per scenario: the invite token ref is a GLOBAL AsyncStorage
  // key (`spotter.invite:v1`) and the dev accept path resolves a code across ALL
  // dev users, so a reused token would pair this witness with an EARLIER
  // scenario's maker. Clearing it makes each scenario a clean install.
  await storage.removeItem('spotter.invite:v1');
  const invite = await getOrCreateInviteCode();
  if (!invite || !invite.displayCode) throw new Error('no dev invite code');
  const witnessId = await freshUser(partnerEmail, false); // switches the session to the witness
  const acc = await acceptInvite(invite.displayCode);
  if (!acc || !acc.ok) throw new Error(`acceptInvite failed: ${acc && acc.error}`);
  await authenticate(makerEmail, 'pass1234'); // back to the maker
  const makerId = (await getStoredSession()).user.id;
  // Both halves are meant to be a pair that has been TOGETHER for weeks: every
  // scenario below judges an already-completed week ("I missed last week"). The
  // dev store stamps a brand-new membership at real-now, which is a joiner who
  // was NOT present for that week — so backdate what is being modelled.
  await stampSharedGroupJoinedAt(makerId, joinedWeeksAgo(6));
  return { makerId, witnessId };
}

const run = async () => {
  if (!model) return;

  // ------------------------------------------------------------------------
  // SCENARIO 1 — missed week + note set → exactly one Open entry
  // ------------------------------------------------------------------------
  const A_EMAIL = 'rollover.maker@spotter.test';
  const B_EMAIL = 'rollover.witness@spotter.test';
  const NOTE = 'an extra long run';
  let A_ID = null;
  let B_ID = null;
  let weekStart = null;
  try {
    const pair = await pairWith(A_EMAIL, B_EMAIL);
    A_ID = pair.makerId;
    B_ID = pair.witnessId;
    const setNote = await setMissNote(NOTE, null); // 2-person group → witness auto-resolves
    if (!setNote.ok) throw new Error(`setMissNote failed: ${setNote.error}`);

    // Raw dev-store read (NOT fetchLedger: the ledger read resolves member
    // names through fetchWeeklyContext, so it would itself warm the rollover).
    const before = await devMock.listLedgerFor(A_ID);
    check(
      'S1: ledger starts EMPTY and no RPC has run before the context fetch (the gap this fix closes)',
      before.length === 0 && rpcCount() === 0,
      `rows=${before.length} rpcCalls=${rpcCount()}`,
    );

    const ctx = await fetchWeeklyContext();
    check(
      'S1: fetchWeeklyContext (the real rollover point) still returns a healthy context',
      ctx.ok === true,
      ctx.ok ? `logs=${ctx.context.logs.length}` : String(ctx.error),
    );

    const ledger = await fetchLedger();
    const entry = ledger[0];
    check(
      'S1: a completed MISSED week with a note set creates exactly ONE Open ledger entry',
      ledger.length === 1 && !!entry && entry.state === 'open' && entry.makerId === A_ID && entry.witnessId === B_ID && entry.promiseText === NOTE,
      `rows=${ledger.length} ${JSON.stringify(entry && { state: entry.state, maker: entry.makerId === A_ID, witness: entry.witnessId === B_ID, text: entry.promiseText })}`,
    );

    weekStart = entry ? entry.weekStart : null;
    const expected = elapsedWeekStart(0, nowUtc());
    check(
      'S1: the entry is stamped with the previous FULLY-ELAPSED week, not the current one',
      weekStart === expected.toISOString() && new Date(weekStart).getUTCSeconds() === 0 && new Date(weekStart).getTime() < nowUtc().getTime(),
      `week_start=${weekStart} expected=${expected.toISOString()}`,
    );

    check('S1: the wiring called the RPC exactly once for that week', rpcCount() === 1, `rpcCalls=${rpcCount()} ${JSON.stringify(rpcCalls)}`);

    // Reopening the app repeatedly (the owner's explicit worry).
    await fetchWeeklyContext();
    await fetchWeeklyContext();
    const afterOpens = await fetchLedger();
    check(
      'S1: two more app opens after the week ended do NOT create a second entry',
      afterOpens.length === 1 && afterOpens[0].id === ledger[0].id,
      `rows=${afterOpens.length}`,
    );
    check(
      'S1: those re-opens do NOT hammer the RPC (still exactly one call)',
      rpcCount() === 1,
      `rpcCalls=${rpcCount()}`,
    );

    // Lost local flag (fresh install / second device / concurrent fetch) → the
    // server's UNIQUE(membership_id, week_start) must still hold the line.
    await rollover.clearPromiseRolloverFlag(A_ID, weekStart);
    await fetchWeeklyContext();
    const afterRefire = await fetchLedger();
    check(
      'S1: with the local once-flag cleared the RPC runs again — and the SERVER keeps it at one entry',
      rpcCount() === 2 && afterRefire.length === 1 && afterRefire[0].id === ledger[0].id,
      `rpcCalls=${rpcCount()} rows=${afterRefire.length}`,
    );

    // The once-flag is per user+week: an EARLIER missed week is not suppressed.
    const olderNow = new Date(elapsedWeekStart(0, nowUtc()).getTime() + 3 * 24 * 3600_000); // mid-older-week
    const older = await rollover.recordMissedPromiseForCompletedWeek(olderNow, MON, GOAL);
    const olderStart = elapsedWeekStart(1, nowUtc()).toISOString();
    check(
      'S1: a DIFFERENT (earlier) week is not suppressed by the previous week\u2019s flag',
      older.ran === true && older.created === true && older.weekStartAt === olderStart,
      JSON.stringify(older),
    );
    const bothWeeks = await fetchLedger();
    check(
      'S1: the ledger now holds one Open entry per missed week (2 total, newest first)',
      bothWeeks.length === 2 &&
        bothWeeks.every((e) => e.state === 'open') &&
        bothWeeks[0].weekStart > bothWeeks[1].weekStart,
      bothWeeks.map((e) => e.weekStart).join(' > '),
    );
  } catch (error) {
    check('S1: missed week + note set → one Open entry (scenario ran to completion)', false, `${error.message}`);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 2 — a completed missed week WITHOUT a note → nothing, ever.
  // (Same maker/witness pair as S1: the dev mock has ONE shared pair group, so
  // a second pair in the same process would contaminate the first — the
  // existing suite has the same one-pair constraint. The variation here is the
  // WEEK, driven through the same entry point the wiring calls.)
  // ------------------------------------------------------------------------
  try {
    const noNoteWeek = elapsedWeekStart(2, nowUtc());
    const noNoteIso = noNoteWeek.toISOString();
    const cleared = await setMissNote('', null); // clear the note (S1's week is untouched)
    if (!cleared.ok) throw new Error(`clear setMissNote failed: ${cleared.error}`);
    const callsBefore = rpcCount();
    const outcome = await rollover.recordMissedPromiseForCompletedWeek(clockAfter(noNoteWeek), MON, GOAL);
    const rowsNow = await devMock.listLedgerFor(A_ID);
    check(
      'S2: a completed missed week with NO note records NOTHING (the RPC answers created:false — never shaming)',
      outcome.ran === true && outcome.created === false && outcome.reason === 'not_recorded' && rowsNow.every((r) => r.week_start !== noNoteIso),
      JSON.stringify(outcome),
    );
    const flagged = await rollover.isPromiseRolloverProcessed(A_ID, noNoteIso);
    const again = await rollover.recordMissedPromiseForCompletedWeek(clockAfter(noNoteWeek), MON, GOAL);
    check(
      'S2: that no-op still happens ONCE per week (flag set → later opens do not re-ask)',
      flagged === true && again.ran === false && again.reason === 'already_processed' && rpcCount() === callsBefore + 1,
      `flagged=${flagged} second=${JSON.stringify(again)} rpcCalls=${rpcCount() - callsBefore}`,
    );
  } catch (error) {
    check('S2: a missed week with no note records nothing (scenario ran to completion)', false, `${error.message}`);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 3 — a completed week that MET the goal → nothing, and no server call
  // ------------------------------------------------------------------------
  try {
    const metWeek = elapsedWeekStart(3, nowUtc());
    const metIso = metWeek.toISOString();
    const setNote = await setMissNote('a coffee', null); // note IS set — the goal is the only reason
    if (!setNote.ok) throw new Error(`setMissNote failed: ${setNote.error}`);
    for (let i = 0; i < GOAL; i += 1) {
      const at = new Date(metWeek.getTime() + (i + 1) * 3600_000).toISOString();
      await devMock.pushWorkout(A_ID, workRow(A_ID, at));
    }
    const callsBefore = rpcCount();
    const outcome = await rollover.recordMissedPromiseForCompletedWeek(clockAfter(metWeek, 12 * 3600_000), MON, GOAL);
    const rowsNow = await devMock.listLedgerFor(A_ID);
    check(
      'S3: a completed week that MET the goal records nothing and never asks the server',
      outcome.ran === false && outcome.reason === 'goal_met' && rpcCount() === callsBefore && rowsNow.every((r) => r.week_start !== metIso),
      JSON.stringify(outcome),
    );
  } catch (error) {
    check('S3: a met week records nothing (scenario ran to completion)', false, `${error.message}`);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 4 — pair-privacy of the NEW entry inside a 3-person group
  // ------------------------------------------------------------------------
  try {
    const MAYA_ID = 'dev_member_maya';
    const CREW_EMAIL = 'crew@spotter.test';
    await authenticate(CREW_EMAIL, 'pass1234'); // seeds the 3-person demo group
    const crewId = (await getStoredSession()).user.id;
    const memberships = await devMock.getDevMemberships(crewId);
    const inDemo = memberships.filter((m) => m.group_id === DEV_DEMO_GROUP_ID);
    if (inDemo.length !== 1) throw new Error(`demo group not seeded (${memberships.length} memberships)`);
    // The seeded crew joined "hours ago" — i.e. AFTER the completed week this
    // scenario judges. Same shape as above: model a group that has been
    // together for weeks before asking about a completed week.
    await stampSharedGroupJoinedAt(crewId, joinedWeeksAgo(6));
    const setNote = await setMissNote('a cold brew', MAYA_ID); // explicit witness pick (3+ group)
    if (!setNote.ok) throw new Error(`setMissNote failed: ${setNote.error}`);

    await fetchWeeklyContext();
    const crewLedger = await fetchLedger();
    const created = crewLedger.find((e) => e.makerId === crewId);
    check(
      'S4 (3-person group): the missed week is recorded for the maker, witnessed by the picked member',
      !!created && created.state === 'open' && created.witnessId === MAYA_ID && created.promiseText === 'a cold brew',
      `rows=${crewLedger.length} ${JSON.stringify(created && { state: created.state, witness: created.witnessId })}`,
    );
    if (!created) throw new Error('the 3-person rollover created no entry — later checks need it');

    await authenticate('maya@spotter.test', 'pass5678');
    const mayaLedger = await fetchLedger();
    check(
      'S4: the WITNESS sees the new entry (she is one half of the pair)',
      mayaLedger.some((e) => e.id === created.id),
      `rows=${mayaLedger.length}`,
    );

    await authenticate('jules@spotter.test', 'pass5678');
    const julesLedger = await fetchLedger();
    check(
      'S4: a NON-witness co-member of the same group sees NOTHING from that pair',
      !julesLedger.some((e) => e.id === created.id) && !julesLedger.some((e) => e.makerId === crewId),
      `rows=${julesLedger.length} ${JSON.stringify(julesLedger.map((e) => e.makerId))}`,
    );
  } catch (error) {
    check('S4: pair-private inside a 3-person group (scenario ran to completion)', false, `${error.message}`);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 6 — a completed week that STARTED BEFORE the member joined the
  // group is NOT a miss: nothing may be recorded (the false-miss defect).
  // This is the case that fails on the unfixed rollover, which asked only
  // "snapshot, else my logs < goal" and never looked at the membership start.
  // ------------------------------------------------------------------------
  try {
    if (!A_ID) throw new Error('S1 did not run — the pair state is missing');
    await authenticate(A_EMAIL, 'pass1234');
    const note = await setMissNote('a coffee', null); // note IS set: the join date is the only reason
    if (!note.ok) throw new Error(`setMissNote failed: ${note.error}`);

    const shared = await devMock.findSharedDevGroup(A_ID);
    if (!shared) throw new Error('the maker has no shared dev group');

    // A week no other scenario touches (4 back), and a membership that began
    // MID-week inside it — the brief's case: a brand-new joiner, who never had
    // the full week to hit the goal.
    const joinedWeek = elapsedWeekStart(4, nowUtc());
    const joinedIso = joinedWeek.toISOString();
    const midWeekJoin = new Date(joinedWeek.getTime() + 3 * 24 * 3600_000).toISOString();
    await stampMyMembership(A_ID, shared.group_id, midWeekJoin);

    const callsBefore = rpcCount();
    const outcome = await rollover.recordMissedPromiseForCompletedWeek(clockAfter(joinedWeek), MON, GOAL);
    const rowsNow = await devMock.listLedgerFor(A_ID);
    check(
      'S6: a completed week that began BEFORE the member joined records NOTHING (no false miss, no RPC call)',
      outcome.ran === false &&
        outcome.reason === 'before_membership' &&
        outcome.weekStartAt === joinedIso &&
        rpcCount() === callsBefore &&
        rowsNow.every((r) => r.week_start !== joinedIso),
      `${JSON.stringify(outcome)} rpcCalls=${rpcCount() - callsBefore} rows=${rowsNow.length}`,
    );
  } catch (error) {
    check('S6: a pre-membership completed week records nothing (scenario ran to completion)', false, `${error.message}`);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 5 — static: RLS was not widened and the client still writes only
  // through the RPC (pair-private by construction).
  // ------------------------------------------------------------------------
  try {
    const schema = fs.readFileSync(SCHEMA, 'utf8');
    const block = schema.split('create table if not exists public.promise_entries')[1] || '';
    const policies = (schema.match(/create policy "[^"]+" on public\.promise_entries\s+for (\w+)/g) || []).map((p) => p.split('for ')[1]);
    const selectOnly = policies.length === 1 && policies[0] === 'select';
    const pairPredicate = /create policy "promise_entries_select_pair" on public\.promise_entries\s+for select using \(\s*auth\.uid\(\) = user_id or auth\.uid\(\) = witness_id\s*\)/.test(schema);
    check(
      'S5: promise_entries RLS is UNCHANGED — one pair-column SELECT policy, no write policy',
      selectOnly && pairPredicate,
      `policies=${JSON.stringify(policies)} pairPredicate=${pairPredicate} tableBlock=${block.length > 0}`,
    );
    const rolloverSrc = fs.readFileSync(ROLLOVER_SRC, 'utf8');
    const directWrites = /from\(\s*['"]promise_entries['"]\s*\)\s*\.\s*(insert|upsert|update|delete)/.test(rolloverSrc);
    check(
      'S5: the rollover client reaches the ledger only through the RPC (no direct table write)',
      !directWrites && /recordMissedPromise\(/.test(rolloverSrc) && !directWrites,
      `directWrites=${directWrites}`,
    );
  } catch (error) {
    check('S5: RLS + write-path static checks (scenario ran to completion)', false, `${error.message}`);
  }
};

run()
  .then(() => {
    console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL`);
    process.exit(fails === 0 ? 0 : 1);
  })
  .catch((error) => {
    // Harness-level failure (module load, stub wiring): still a FAIL, still non-zero.
    check('harness: guard ran to completion', false, `${error.name}: ${error.message}`);
    console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL`);
    process.exit(1);
  });
