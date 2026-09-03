# SPOTTER — Mobile App (Phase 1 MVP, Slice A)

Expo (React Native) + TypeScript single codebase for iOS + Android. Auth +
onboarding built directly from the design package (`/home/team/shared/design/`):
`tokens.json`, `tokens.md`, `onboarding.md`, `home-screen.md`, `README.md`.

## Stack

- **Expo SDK 57** (`expo-router` file-based routing — chosen over React Navigation
  because the template is first-party, typed routes are on, and the app's route
  shape (auth gate → onboarding stack → home) is a natural Stack + Tabs tree).
- **Supabase** (`@supabase/supabase-js`) for auth + Postgres; sessions persisted
  via `expo-secure-store` (KV on web).
- **Design tokens** in `src/theme/tokens.ts` — auto-generated, never hand-edited.
- **AsyncStorage** for the dev-mode mock only.

## Run it

```sh
npm install        # Expo SDK 57 + supabase-js + secure-store + async-storage
npm start          # dev server (QR for Expo Go / dev build)
npm run ios        # iOS sim
npm run android    # Android emulator
npm run web        # web (desktop preview)
```

No `.env` needed for default dev mode. To switch to REAL mode, create a
`.env` in the repo root with the two `EXPO_PUBLIC_` vars for your Supabase
project (Metro inlines them at start; there is no checked-in `.env.example`
— the two vars are the whole contract):

```sh
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
```

## Two backend modes (auto-detected)

| Mode | When | What happens |
|---|---|---|
| **DEV MOCK** | `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` **absent** (default) | App runs end-to-end against a clearly-labeled local mock in `src/lib/mock.ts` (AsyncStorage-backed; session + stub user + persisted onboarding settings). Welcome screen shows “DEV DEMO — LOCAL MOCK”. No network. |
| **REAL** | both env vars **present** | `src/lib/supabase.ts` creates the real client; onboarding writes users/groups/memberships per `supabase/schema.sql`. Sessions persist via SecureStore. |

Switching modes is just setting/removing the two env vars.

## Auth (single path, per design README)

One screen — no create-vs-login fork. “Get started” reveals an inline
email+password form on the Welcome screen; submit → `authenticate()` in
`src/lib/supabase.ts`:
- REAL mode: tries `signInWithPassword`, falls back to `signUp` if the account
  doesn't exist (one tap, no fork); onboarding then ensures a personal
  `groups` row and writes `users` + `memberships` rows (see `supabase/schema.sql`).
- DEV MOCK: creates a labeled `dev_*` demo user + session locally.

Terms line: the privacy promise only (photos sealed to your account) — honest,
minimal, no invented features.

## Onboarding (under 60s comfortable path)

Welcome → Set weekly goal (1–7 chips, preset **3**) → Week-start day (Mon..Sun,
preset **Mon**) → Home. Skip/back per spec; commit happens only on “Let's go”
or “Skip for now” (kill mid-flow re-enters at the same step). Camera permission
is **never** requested during onboarding (app.json only declares the usage
string; it's requested on the first real camera tap in slice B).

## Design tokens — keep them in sync

`tokens.json` is the single source of truth. The typed module is generated:

```sh
npm run tokens        # regenerates src/theme/tokens.ts
npm run tokens:check  # fails if tokens.ts is stale (run in CI)
```

Component styles reference token exports (`colors`, `typeScale`, `spacing`,
`radius`, `buttons`, `cameraButton`, `weeklyRing`, `motion`, …) — no ad-hoc
colors. Dark theme is the only theme.

## Icons & splash

- `assets/branding/icon-source.png` (design package, 1024²) → wired in
  `app.json` (`expo.icon` = icon; splash plugin `image` = splash-source.png,
  bg `#0A0C08`).
- Platform sets regenerate via `npm run icons` (uses `sharp`):
  - iOS `Assets.xcassets/AppIcon.appiconset` (20 sizes + Contents.json) and
    Android adaptive mipmaps + launcher/round at 5 densities + anydpi-v26 XML.
  - `expo prebuild` / EAS consume these at build time; the launch screen behind
    the splash is the base dark `#0A0C08`.
  - On a fresh clone the check script `npm run icons:check` verifies the
    generated set is fresh vs the source png (regenerate before shipping).

## Supabase schema (seed for the real project)

`supabase/schema.sql` — `users` (1:1 auth.users; week_start_day, timezone,
name), `groups`, `memberships` (weekly_goal per group+user; unique group+user).
RLS enabled on all three with policies scoped to `auth.uid()`:
- users: select/insert/update/delete own row only.
- groups: select via membership; insert by creator.
- memberships: select by same-group members; insert/update/delete own row only.

**Apply:** paste the file into the Supabase SQL editor, or `supabase db push`
after `supabase init` + linking, or run the CLI with a local Postgres
(`supabase start`, then `supabase db reset`). You only need records to match
the app's `src/lib/database.types.ts` — same tables/columns.

**Photo isolation (trust requirement):** the RLS pattern is set now — every
future workouts/storage row is scoped to `auth.uid()`; the private `workouts`
storage bucket and its policies are built in slice B (see the schema footer
comment). Never relax these policies.

## Verification

```sh
npm run typecheck    # tsc --noEmit (strict)
npm run export:ios   # bundles for iOS
npm run export:android # bundles for Android
```

## Connect a remote later

No remote is linked yet — local repo only. When the team has a GitHub org:

```sh
git remote add origin git@github.com:<org>/spotter-mobile.git
git push -u origin main
```

`npm run` scripts above work unchanged; swap `.gitignore`-ignored `.env` per
mode.

## Slice B (not built here)

Camera logging + photo-proof storage: `expo-camera`, the private `workouts`
storage bucket + per-user RLS, the single weekly-context home query
(home-screen.md §8), feed cards, invite flow. Home is a stub that proves
routing. Reactions are explicitly MVP-UI-ONLY (flag in code if/when rendered).