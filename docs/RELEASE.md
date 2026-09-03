# RELEASE.md — SPOTTER iOS: zero → TestFlight

Runbook for the app lead. **All commands in this doc run from the repo root
(`/home/team/shared/app`) on a machine that has an EAS login and the Apple
credentials listed below.** Run them roughly in order; step 1 is a hard
prerequisite, everything after it can be repeated.

Before you start, confirm the working tree is clean:

```sh
git status            # expect: nothing to commit, working tree clean
git log --oneline -1  # expect: the EAS prep commit (see end of this doc)
```

---

## 0. What you need from the owner, all external

- **Expo account token** — plain `eas login` (username/password) is fine; no
  `EXPO_TOKEN` needed unless you want non-interactive CI later.
- **Apple Developer (Individual) credentials** and either:
  - **App Store Connect API Key (recommended)** — Issuer ID, Key ID, and the
    `.p8` key file, with **App Manager** role on App Store Connect. `eas submit`
    keeps the key's credentials in EAS and reuses it for future submissions, so
    you only paste it once.
  - or **appleId + app-specific password** — an Apple ID (2FA on) and an
    app-specific password created at https://appleid.apple.com → Sign-In &
    Security → App-Specific Passwords. You will re-enter it on every `eas
    submit`.
- **Supabase project URL + anon key** (for "Real mode", §6). Not needed to ship
  the DEV MOCK build.

Nothing above exists on this machine — that is why this doc exists.

---

## 1. `eas init`

One-time project setup. Creates the linked EAS project (and `.eas/project-id`,
a committed file — commit it with the new `eas init` scaffold if it appears).

```sh
npx eas init
```

No flags needed. If it asks whether to use the connected account, say yes.
This does **not** build or submit — it only links the repo to the EAS project.

---

## 2. Internal testers (TestFlight) in App Store Connect

Do this in the browser at https://appstoreconnect.apple.com:

1. Users and Access → **TestFlight** → **Internal Testing** → **Add App Store
   Connect Users** → add the testers (email addresses; needs at least one).
2. Create a tester group (e.g. "SPOTTER internal") if none exists and add those
   users to it.
3. The group must be assigned to the app. If the app record
   doesn't exist yet (first submission), add it after the first send — an
   **internal group must have at least one build** before it can be used, and
   the first build can only be reached from the app record once it exists
   (auto-created by `eas submit`, step 4).

**Apple's rule:** internal testers (up to 100) need no Beta App Review; they
see builds after you flip "Notify Testers" or they refresh the app page in
TestFlight.

---

## 3. Build

### How build numbers work now (appVersionSource: remote)

`eas.json` sets `cli.appVersionSource: "remote"` (this is the `eas-cli`
init template). With it, **the build number and version are stored server-side
in EAS and are auto-incremented on each build** — local `app.json` edits to
buildNumber are **not** read back once the remote baseline exists.

- This repo's local baseline is `expo.version: "1.0.0"`, `ios.buildNumber: "1"`.
- The first build *initializes* the remote values from local config; per the
  EAS docs, the very first remote build typically starts at **2** (the baseline
  is treated as already-incremented). That is expected and harmless — what
  matters is every *later* build gets a strictly higher build number.
- `build.production` has `autoIncrement: true` + `channel: "production"`, so
  the store build always bumps the number and updates the Production channel.
- `ios.supportsTablet` is already `true` in `app.json` (required for the App
  Store) — do not remove it.

### Actually build

```sh
npx eas build -p ios --profile production
```

- Asks you to log in to Expo and set up Apple credentials (the certificate /
  provisioning profile). Use **"Yes"** when it offers to generate the
  distribution certificate and provisioning profile automatically — EAS
  manages the signing.
- On the Apple-credentials question, this is a dev-machine build now and
  TestFlight-bound, so answer **"Development"** if asked to choose between
  Development and Distribution (the build is signed with a distribution cert
  either way; the prompt only picks which profile flow).
- Flag `--non-interactive` only if everything (credentials, target, build
  profile) has been set up before and you are re-running a known-good build.
- When the build succeeds, the CLI prints URLs: the build page, an install
  link, and for store builds a **"submit"** hint — copy nothing extra, just run
  step 4.

Expected duration: ~20–40 min; EAS emails updates and the CLI streams logs.

---

## 4. Submit to TestFlight (App Store Connect)

### Does a TestFlight app record have to pre-exist?

**No.** Per the EAS docs for `eas submit` (`docs.expo.dev/submit/ios`, page
"Submit to TestFlight"): "When you run _eas submit_, it will
**auto-create the app record** if it does not exist" — provided the bundle
identifier is registered on your Apple Developer account. See
https://developer.apple.com/account/resources/identifiers → App IDs; if
`app.spotter.mvp` is not there, create the App ID first (auto-registration on
first `eas build` usually handles this). Source relied on:
- https://docs.expo.dev/submit/testflight/
- https://docs.expo.dev/submit/ios/

This repo does **not** set `submit.production.ios.ascAppId`, so EAS uses the
auto-create path and does **not** skip app-record creation.

### Submit with an API key (recommended)

```sh
npx eas submit -p ios --profile production
```

It will prompt for the **.p8** file, **Key ID**, and **Issuer ID** on first
run (create the key at https://appstoreconnect.apple.com → Users and Access →
Integrations → App Store Connect API). Credentials are stored in EAS and
reused on later submits. The app record is auto-created on first submission
(bundle `app.spotter.mvp`, territory **United States**, version 1.0.0 — the
territory list is confirmed at the prompt).

### Submit with appleId + app-specific password (manual fallback)

Not recommended for repetition (you re-enter the password each time), but if
you do not want to create an ASC API key:

1. `npx eas submit -p ios --profile production`
2. When prompted for Apple credentials, choose **"Apple ID login"** and enter
   the Apple ID + the **app-specific** password (a normal password will not
   work).
3. Same auto-create behavior; the app record is created at first submit.

### First build gotchas

- If no .p8 / no API key exists yet, the submit flow offers to **create the
  key for you** in the Apple Developer portal — accept; it saves the .p8 to EAS.
- After the first submit, install an internal build: **App Store Connect →
  TestFlight → Internal Testing**, select the build, and click the **"Notify
  Testers"** / enable-the-build toggle. Internal groups with no prior build
  can only be configured once the first build is in.

---

## 5. Add / manage internal testers

Already done in step 2; reminder of the exact flow (Apple docs: "TestFlight
beta testing" guide):

1. App Store Connect → TestFlight → **Internal Testing**.
2. Click **+** to add a group, name it (e.g. "SPOTTER team"), add up to 100
   App Store Connect users as testers.
3. Each tester accepts via the **TestFlight app** on their iPhone when they
   get the invite email (they must be in the Internal Testing group, and an
   internal build must exist).
4. Every new build that lands in TestFlight is available to the internal
   group; users update via the TestFlight app.

---

## 6. Real mode (Supabase env vars) — do **after** the first TestFlight pass

**Mechanism chosen: EAS environments** (not the `env` block in `eas.json`).
Facts relied on:
- Per current EAS docs (`docs.expo.dev/build-reference/variables/`,
  "Environment variables" / "How to set..."), the supported way to securely
  set build-time variables is `eas env` / **EAS dashboard environments**,
  selected per profile with an `"environment"` field in the build profile.
- The `env` block in `eas.json` is documented as intended for **values you
  would commit in the repo** (e.g. a public API URL), of limited use for
  secrets, and is not how EAS injects the real-mode Supabase values.
- This repo's `build.production` already declares `"environment": "production"`
  so the chosen environment applies automatically to store builds.

`EXPO_PUBLIC_*` variables are inlined by Metro/EAS **at build time** (not at
launch): apps use `process.env.EXPO_PUBLIC_SUPABASE_URL` /
`EXPO_PUBLIC_SUPABASE_ANON_KEY`; both absent → DEV MOCK, both present → REAL.

### Switching the production channel to REAL Supabase

```sh
# 1. Create the environment (one-time; keeps values out of git)
npx eas env:set EXPO_PUBLIC_SUPABASE_URL --environment production
# paste: https://<project-ref>.supabase.co

npx eas env:set EXPO_PUBLIC_SUPABASE_ANON_KEY --environment production
# paste: the anon key (public; still kept out of git)
```

Both commands prompt for the value (hidden input) and then update the
production environment. If the EAS dashboard is preferred: Project →
Environments → production → Add variable, same two names.

### Rebuild so the values are inlined

```sh
npx eas build -p ios --profile production   # same command as step 3
npx eas submit -p ios --profile production  # and resubmit to TestFlight
```

Every store build (production profile) automatically gets the production
environment's variables.

### Verification on device

In real mode the app goes to the network backend: sign-up/sign-in against
Supabase Auth, photo uploads to Supabase Storage, and all rows scoped via RLS.
Sanity checks before announcing to testers:
- `npm start` locally with a `.env` file? Keep the committed config free of
  real values (`.env` is now gitignored — but whether stores pick up `.env`
  depends on local config; EAS environments are the source of truth for cloud
  builds).
- In TestFlight, sign-up with a new email, log one camera workout, and confirm
  the feed and ring work end-to-end.
- **Account deletion (App Store 5.1.1(v) BLOCKER):** after applying
  `supabase/schema.sql` to the project, create a **throwaway test account** and
  verify Delete account (Profile → Delete account → confirm) removes the auth
  user and their photo logs/files end-to-end before submission.

### Reverting to DEV MOCK builds

Delete the two variables from the production environment (dashboard) or
`npx eas env:unset EXPO_PUBLIC_SUPABASE_URL --environment production` (and the
key), then rebuild. Absence of either variable at build time = DEV MOCK.

---

## 7. Non-goals / not in this runbook

- **No `build.development`/dev-client profile yet.** It would need
  `expo-dev-client` added to dependencies (not present), which adds
  native-module surface for a feature nobody can consume yet. When a native
  debug build is wanted, add the dependency and a `development` profile
  (`developmentClient: true`, `distribution`: internal, own channel) — until
  then it's dead config and was deliberately omitted.
- No paid subscription, no in-app purchases (MVP is free; App Store
  submission needs no IAP setup).
- No push notifications in the MVP (not configured here).
- Android is not in this runbook (US iOS-first MVP).
- EAS **Local** builds are not covered; this is the standard cloud flow.

---

## Change log

- `eas.json` (new): `cli.appVersionSource: "remote"`; `build.production`
  (store distribution, `autoIncrement: true`, channel/environment
  "production"); `submit.production.ios` (no Apple creds in repo — the .p8 /
  key material lives in EAS + ASC).
- `app.json`: `version` → "1.0.0"; added `ios.buildNumber: "1"` (remote
  baseline). `bundleIdentifier: app.spotter.mvp`, camera permission string,
  `supportsTablet: true` left as-is.
- `.gitignore`: ignore `.env` / all `.env.*` except `.env.example` (bare `.env`
  with real values must never be committed).
- This doc: `docs/RELEASE.md`.