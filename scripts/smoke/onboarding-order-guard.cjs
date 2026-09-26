#!/usr/bin/env node
/*
 * onboarding-order-guard — the offline check that a brand-new account can
 * finish onboarding AT ALL.
 *
 * WHY IT EXISTS (F1, 2026-09-23 — live, release-blocking):
 * `commitOnboarding()` in src/lib/settings.ts wrote the user's own Personal
 * GROUP before the `public.users` row that group references. `groups.creator_id`
 * is `not null references public.users (id)` (supabase/schema.sql:55) and
 * NOTHING mirrors auth.users → public.users (there is no handle_new_user
 * trigger anywhere), so on a genuinely new account the group insert violated
 * the FK and onboarding could NEVER commit:
 *
 *   insert or update on table "groups" violates foreign key constraint
 *   "groups_creator_id_fkey"        (captured live, twice, 2026-09-23)
 *
 * Every new user therefore stuck on the onboarding screen forever — including
 * an App Review reviewer signing up fresh. Nothing offline caught it because
 * the dev-mock suite never reaches the real-mode branch, and
 * scripts/real-mode-smoke/run_smoke.py inserts users → groups → memberships by
 * hand, i.e. it worked around the very ordering the app got wrong.
 *
 * WHAT IT DOES: it runs the REAL compiled `commitOnboarding` (the app's own
 * module, transpiled from src/lib/settings.ts) against an in-memory fake
 * Supabase client that ENFORCES the two foreign keys and the pair uniqueness
 * the live database enforces, then asserts on the result, the write ORDER and
 * the rows that landed. If someone swaps the two writes back, the fake rejects
 * the group insert exactly as Postgres does and check 3 goes red.
 *
 * The fake's rejection text is the live error text captured on 2026-09-23, and
 * check 2 replays the OLD order through it — so the guard carries its own
 * negative control and cannot silently stop being able to see the bug.
 *
 * WHAT IT DOES NOT PROVE: the real Postgres plan/RLS, the network path, the
 * on-device render, or the invite path end to end. Those are the live harness
 * (/home/team/shared/rollover-live-harness.cjs) and scripts/real-mode-smoke.
 *
 * RUN:  node scripts/smoke/onboarding-order-guard.cjs   (exit 1 on any FAIL)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const COMPILED = path.join(ROOT, 'scripts', 'smoke', '.compiled');
const SETTINGS_SRC = path.join(ROOT, 'src', 'lib', 'settings.ts');
const ENTER_CODE_SRC = path.join(ROOT, 'src', 'features', 'invites', 'EnterCodeScreen.tsx');
const SCHEMA = path.join(ROOT, 'supabase', 'schema.sql');

// ---------------------------------------------------------------------------
// tiny reporter (one PASS/FAIL line per check; fixed expected count 15)
// ---------------------------------------------------------------------------
let passes = 0;
let fails = 0;
function check(name, ok, detail) {
  if (ok) passes += 1;
  else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}
const LIVE_FK_ERROR =
  'insert or update on table "groups" violates foreign key constraint "groups_creator_id_fkey"';

// ---------------------------------------------------------------------------
// 1. compile the real lib modules (the same step the offline suite runs)
// ---------------------------------------------------------------------------
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
  console.log('SUMMARY: 0 PASS / 1 FAIL (compile failed; nothing else could run)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. the fake client that models the live database
// ---------------------------------------------------------------------------
function makeDb() {
  const db = {
    users: new Map(), // id -> row
    groups: new Map(), // id -> row
    memberships: new Map(), // id -> row
    writes: [], // ordered log of write statements, e.g. 'users.upsert'
    seq: 0,
    nextId(prefix) {
      db.seq += 1;
      return `${prefix}-${String(db.seq).padStart(3, '0')}`;
    },
    reset() {
      db.users.clear();
      db.groups.clear();
      db.memberships.clear();
      db.writes = [];
      db.seq = 0;
    },
  };
  return db;
}
const DB = makeDb();

/** Apply one queued statement against the fake database, enforcing the FKs. */
function apply(op) {
  const { table, method, row } = op;
  if (op.applied) return op.result; // memoized: one statement, one effect
  op.applied = true;
  const err = (message) => ({ data: null, error: { message } });

  if (method === 'select') {
    if (table === 'groups' && op.filter && op.filter.col === 'creator_id') {
      const hit = [...DB.groups.values()].find((g) => g.creator_id === op.filter.val) ?? null;
      return (op.result = { data: hit ? { id: hit.id } : null, error: null });
    }
    return (op.result = { data: null, error: null });
  }

  if (table === 'users' && (method === 'upsert' || method === 'insert')) {
    if (!row.id || !row.name || !row.week_start_day) {
      return (op.result = err('null value in column "name" of relation "users" violates not-null constraint'));
    }
    const existing = DB.users.get(row.id);
    DB.users.set(row.id, {
      ...row,
      created_at: existing ? existing.created_at : new Date().toISOString(),
    });
    DB.writes.push('users.upsert');
    return (op.result = { data: null, error: null });
  }

  if (table === 'groups' && (method === 'insert' || method === 'upsert')) {
    if (!row.name) {
      return (op.result = err('null value in column "name" of relation "groups" violates not-null constraint'));
    }
    // THE LIVE CONSTRAINT: groups.creator_id -> public.users(id), not null.
    if (!DB.users.has(row.creator_id)) {
      return (op.result = err(LIVE_FK_ERROR));
    }
    const id = DB.nextId('grp');
    DB.groups.set(id, { id, name: row.name, creator_id: row.creator_id, created_at: new Date().toISOString() });
    DB.writes.push('groups.insert');
    return (op.result = { data: { id }, error: null });
  }

  if (table === 'memberships' && (method === 'upsert' || method === 'insert')) {
    // memberships.user_id -> public.users(id), not null (schema.sql:86)
    if (!DB.users.has(row.user_id)) {
      return (op.result = err('insert or update on table "memberships" violates foreign key constraint "memberships_user_id_fkey"'));
    }
    if (!DB.groups.has(row.group_id)) {
      return (op.result = err('insert or update on table "memberships" violates foreign key constraint "memberships_group_id_fkey"'));
    }
    const pairKey = `${row.group_id}|${row.user_id}`;
    const existing = [...DB.memberships.values()].find((m) => `${m.group_id}|${m.user_id}` === pairKey);
    if (existing) {
      // unique (group_id, user_id) + upsert onConflict => update in place.
      Object.assign(existing, { weekly_goal: row.weekly_goal, role: row.role });
      DB.writes.push('memberships.upsert(update)');
      return (op.result = { data: null, error: null });
    }
    if (op.onConflict !== 'group_id,user_id') {
      return (op.result = err('there is no unique or exclusion constraint matching the ON CONFLICT specification'));
    }
    const id = DB.nextId('mem');
    DB.memberships.set(id, { id, ...row, created_at: new Date().toISOString() });
    DB.writes.push('memberships.upsert');
    return (op.result = { data: null, error: null });
  }

  return (op.result = err(`unexpected statement ${table}.${method}`));
}

/** A supabase-js-shaped, chainable, awaitable statement builder. */
function builder(table) {
  const op = { table, method: 'select', row: null, filter: null, onConflict: null };
  const api = {
    select() {
      return api;
    },
    eq(col, val) {
      op.filter = { col, val };
      return api;
    },
    order() {
      return api;
    },
    limit() {
      return api;
    },
    insert(row) {
      op.method = 'insert';
      op.row = row;
      return api;
    },
    upsert(row, opts) {
      op.method = 'upsert';
      op.row = row;
      op.onConflict = opts ? opts.onConflict : null;
      return Promise.resolve(apply(op));
    },
    maybeSingle() {
      return Promise.resolve(apply(op));
    },
    single() {
      return Promise.resolve(apply(op));
    },
    then(resolve, reject) {
      return Promise.resolve(apply(op)).then(resolve, reject);
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// 3. load the REAL commitOnboarding against the fake client
//    (a throwaway dir so the module's `require('./supabase')` picks up the fake;
//    the repo's own compiled output is never modified)
// ---------------------------------------------------------------------------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'spotter-onboarding-guard-'));
let settingsJs = fs.readFileSync(path.join(COMPILED, 'settings.js'), 'utf8');
if (process.env.SPOTTER_ONBOARDING_GUARD_DEBUG) {
  // `commitOnboarding` swallows any thrown error into "Can't reach server."
  // (correct app behaviour, useless when the harness itself is broken). With
  // this flag the sandboxed copy rethrows instead, so a red run says why.
  settingsJs = settingsJs.replace(
    /return \{ ok: false, error: "Can't reach server\. Try again\." \};/,
    'throw e;',
  );
}
fs.writeFileSync(path.join(SANDBOX, 'settings.js'), settingsJs);
fs.copyFileSync(path.join(COMPILED, 'mock.js'), path.join(SANDBOX, 'mock.js'));

const SESSION = { user: { id: 'user-new-1', email: 'fresh.account@example.invalid' }, isDevMode: false };
fs.writeFileSync(
  path.join(SANDBOX, 'supabase.js'),
  [
    '"use strict";',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    // The fake client. Every chainable call is routed to the guard's apply().
    'exports.supabase = globalThis.__SPOTTER_GUARD__.client;',
    'exports.isDevMode = false;',
    'exports.getStoredSession = async () => globalThis.__SPOTTER_GUARD__.session;',
    '',
  ].join('\n'),
);
globalThis.__SPOTTER_GUARD__ = { client: { from: builder }, session: SESSION };

// mock.js (the dev branch of settings.ts) pulls AsyncStorage — map it to the
// smoke stub, exactly as scripts/smoke-test.mjs does.
const depMap = require(path.join(COMPILED, '_deps.json')).map;
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (depMap[request]) return path.join(ROOT, 'scripts', depMap[request]);
  return origResolve.call(this, request, ...args);
};

const { commitOnboarding } = require(path.join(SANDBOX, 'settings.js'));

// ---------------------------------------------------------------------------
// 2'. the guard's own negative control: replay the OLD (broken) order through
//     the same fake, and prove it is rejected the way the live database
//     rejected it. Without this, a fake that never fails would make every
//     check below vacuous.
// ---------------------------------------------------------------------------
function replayOldOrder() {
  DB.reset();
  DB.users.clear();
  // groups first (creator_id 'ghost-user'), then the users row — the pre-fix order.
  return builder('groups')
    .insert({ name: 'Personal', creator_id: 'ghost-user' })
    .select('id')
    .single();
}
(async () => {
  const oldOrder = await replayOldOrder();
  check(
    'fake database rejects the PRE-FIX order (group before the user row)',
    Boolean(oldOrder.error) && oldOrder.error.message === LIVE_FK_ERROR,
    oldOrder.error ? oldOrder.error.message : 'no error — the fake cannot see the bug',
  );

  // -------------------------------------------------------------------------
  // 3'. the real thing: a brand-new account onboarding
  // -------------------------------------------------------------------------
  DB.reset();
  const first = await commitOnboarding({ weeklyGoal: 3, weekStart: 'Mon' });
  check('fresh account: commitOnboarding reports ok', first.ok === true, first.ok ? '' : first.error);
  check(
    'fresh account: the writes were ordered users -> groups -> memberships',
    DB.writes.join(' > ') === 'users.upsert > groups.insert > memberships.upsert',
    DB.writes.join(' > '),
  );

  const userRow = DB.users.get(SESSION.user.id);
  check(
    'fresh account: one users row with the onboarding settings',
    userRow && userRow.name === 'fresh.account' && userRow.week_start_day === 'Mon' && userRow.timezone,
    JSON.stringify(userRow ?? null),
  );

  const groups = [...DB.groups.values()];
  check(
    'fresh account: one Personal group owned by the caller',
    groups.length === 1 && groups[0].name === 'Personal' && groups[0].creator_id === SESSION.user.id,
    JSON.stringify(groups),
  );

  const memberships = [...DB.memberships.values()];
  check(
    'fresh account: one membership, goal 3, role admin, in that group',
    memberships.length === 1 &&
      memberships[0].user_id === SESSION.user.id &&
      memberships[0].group_id === groups[0].id &&
      memberships[0].weekly_goal === 3 &&
      memberships[0].role === 'admin',
    JSON.stringify(memberships),
  );

  // -------------------------------------------------------------------------
  // 4'. re-onboarding (the app can call this again — e.g. Profile edits
  //     goal/week-start => same commit path): idempotent, never duplicating.
  // -------------------------------------------------------------------------
  const second = await commitOnboarding({ weeklyGoal: 5, weekStart: 'Wed' });
  check('re-onboarding: commitOnboarding reports ok', second.ok === true, second.ok ? '' : second.error);
  // Every check below tolerates a failed earlier scenario (an empty map must
  // read as FAIL, not as a thrown guard) so a red run stays fully legible.
  const groups2 = [...DB.groups.values()];
  check(
    're-onboarding: still exactly one group, same id (no duplicate)',
    groups2.length === 1 && Boolean(groups[0]) && groups2[0].id === groups[0].id,
    `${groups2.length} group(s), ids ${groups2.map((g) => g.id).join(',')}`,
  );
  const memberships2 = [...DB.memberships.values()];
  check(
    're-onboarding: still exactly one membership, same id, settings updated in place',
    memberships2.length === 1 &&
      Boolean(memberships[0]) &&
      memberships2[0].id === memberships[0].id &&
      memberships2[0].weekly_goal === 5,
    JSON.stringify(memberships2),
  );
  const userRowAfter = DB.users.get(SESSION.user.id);
  check(
    're-onboarding: users.created_at preserved (the onboarding marker is stable)',
    Boolean(userRow && userRowAfter) && userRowAfter.created_at === userRow.created_at,
    userRow && userRowAfter ? `${userRow.created_at} -> ${userRowAfter.created_at}` : 'no users row was written',
  );

  // -------------------------------------------------------------------------
  // 5'. source-level invariants (the two places the order lives, and the
  //     database premises that make it load-bearing)
  // -------------------------------------------------------------------------
  const settingsSrc = fs.readFileSync(SETTINGS_SRC, 'utf8');
  const writes = [...settingsSrc.matchAll(/from\('(\w+)'\)\s*\.\s*(upsert|insert|update|delete)/g)].map(
    (m) => `${m[1]}.${m[2]}`,
  );
  check(
    "source: commitOnboarding's write sequence is users -> groups -> memberships",
    writes.join(' > ') === 'users.upsert > groups.insert > memberships.upsert',
    writes.join(' > '),
  );

  const enterSrc = fs.readFileSync(ENTER_CODE_SRC, 'utf8');
  const ci = enterSrc.indexOf('commitOnboarding(');
  const ai = enterSrc.indexOf('await accept()', ci);
  check(
    'source: the join-by-code path commits onboarding before it accepts the invite',
    ci !== -1 && ai > ci,
    `commitOnboarding@${ci} < accept@${ai}`,
  );

  const schema = fs.readFileSync(SCHEMA, 'utf8');
  const fkPresent = /creator_id uuid not null references public\.users \(id\)/.test(schema);
  check(
    'schema: groups.creator_id still references public.users(id) (the premise)',
    fkPresent,
    fkPresent ? 'present — the write order stays load-bearing' : 'the groups.creator_id -> public.users FK is gone from schema.sql',
  );
  const hasMirrorTrigger = /handle_new_user|on_auth_user_created|on auth\.users/i.test(schema);
  check(
    'schema: still NO auth.users -> public.users mirror trigger (no DB backstop)',
    !hasMirrorTrigger,
    hasMirrorTrigger
      ? 'a trigger now mirrors auth.users; the client order is no longer the only guard'
      : 'none — this guard is still the only net for the order',
  );

  console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL (expected 15 PASS)`);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(fails === 0 && passes === 15 ? 0 : 1);
})().catch((e) => {
  console.error('GUARD ERROR:', (e && e.stack) || e);
  console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL (guard threw)`);
  process.exit(1);
});
