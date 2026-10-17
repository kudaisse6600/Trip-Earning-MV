# Verification report — Trip Earnings Pro v3.0.0

Date: 2026-10-17 (Maldives time). Environment: Linux, Node 22.22, Chromium 141 (Playwright), PostgreSQL 16.

## What was tested and passed

### Unit tests — `node --test tests/core.test.js` → 12/12
Preset routes and fares exactly as specified · UTC+5 day boundary at 23:59:59.999 → 00:00:00.000 ·
tips add to earnings and never to trip count · custom tip amounts · target % and achievement thresholds
(25/50/75/100 fire once each, skipped thresholds still shown, nothing after 100) · speed warning state
machine (fires at ≥80, no repeat while fast, re-arms only below 70) · legacy v2 backup parsing (your
`trip-earnings-backup-2026-10-11.json`: 30 records, 24 trips + 6 tips, MVR 1,310 gross) · v3 export →
import round-trip · rejection of invalid files · last-write-wins merge with soft deletes · RPM arithmetic.

### Browser tests — `python3 tests/e2e.py` → 46/46 (headless Chromium at 390×800)
All 7 routes render with correct fares · adding trips/tips updates gross, trip count, tips, ring and bar ·
custom tip sheet · achievement overlay appears at 25% with the exact wording and needs **exactly 3 taps**
(verified still visible after 1 and 2) · 50/75/100 shown once each, in order, none after 100 · undo ·
history grouped by day, delete with confirmation · **midnight reset**: a trip at 23:59 MVT yesterday is
excluded from Today and kept in History; a trip at 00:00:30 MVT today is included · autosave survives reload ·
legacy JSON import (30 records) and day totals · export produces v3 JSON with all records ·
custom route add, fare edit, both persist after reload · target change · dark/light theme switch
(body background verified) · **speed warning** at 82 km/h with exact text, one tap dismisses, no repeat at
95 km/h, re-arms after slowing to 50 then 85 · GPS speed displayed · RPM shows "—" with mic off ·
status badge "Local only" when unconfigured · "Powered by Kuda Isse" present · no horizontal overflow ·
zero JavaScript errors.

### Sync tests — `python3 tests/sync.e2e.py` → 25/25
Against an in-memory stand-in for supabase-js that enforces per-user row filtering. Proves the app's logic:
badge states (Not signed in → Synced → Offline → Sync failed → Synced → Needs attention → Not signed in) ·
sign-in calls `signInWithOAuth({provider:'google'})` with redirect back to the app URL · local data created
before sign-in is uploaded under the signed-in user · offline changes queue (pending count 2), cloud
untouched, flushed on the `online` event · server error while online shows "Sync failed", "Sync now" recovers ·
route edits and soft deletes propagate · a fresh second device restores all data, edited fares and deletions ·
device 1 pulls device 2's new trip on refocus · a different user sees none of user A's rows · a second account
signing in on a device with data triggers the merge/discard sheet, and discard leaves user A's cloud rows
intact · sign-out keeps local data.
One real bug was found and fixed by these tests: a fresh device used to push its default routes before
pulling, overwriting a newer fare edited elsewhere. Sync now pulls and merges before pushing.

### Database / RLS — `bash tests/rls.test.sh` → passed on a real PostgreSQL 16
`supabase/schema.sql` applies cleanly (idempotent). With Supabase's `auth.uid()` emulated via JWT claims:
user A inserts a trip, route and profile · user B sees 0 trips, 0 routes, 0 profiles · B's UPDATE and DELETE
on A's row affect 0 rows · B can own the same preset route id (composite key) and the app's upsert conflict
target `(user_id, id)` works · B cannot insert a row with A's `user_id` (blocked by RLS) · A's data intact ·
the `anon` role cannot read any table.

### Deployment
A live copy is published on claude.ai (link on the card). It verifies the production build renders and the
local features work on a real host. **It is a demo host**: its sandbox blocks service workers, GPS, the
microphone and all network calls to Supabase, so PWA install, Drive mode and Google sign-in cannot be
exercised there. Those need the `public/` folder on your own HTTPS host (README §1).

## What could NOT be tested here, and why

| Item | Status | What's needed |
|---|---|---|
| Real Google OAuth round-trip | **Not tested** — requires your Google Cloud OAuth client and your Supabase project | README §3; then click "Sign in with Google" once |
| Real Supabase sync, reconnection, multi-device | Logic tested against a faithful stand-in; **not run against a live Supabase project** | README §2 and §4 on two devices |
| RLS on hosted Supabase | Policies proven on PostgreSQL 16 with emulated `auth.uid()`; **not run on your hosted project** | Run `schema.sql`; sign in with two Google accounts and confirm each sees only its own trips |
| PWA install prompt | Manifest, icons and service worker are in place; install prompt not observable in headless Chromium or on the demo host | Open your deployed URL in Chrome on Android → menu → "Install app" |
| GPS speed on a real phone | Tested with injected positions only | Drive mode on your phone; speed appears once the GPS has a fix (needs movement) |
| Acoustic RPM | Code path tested for "mic off → dash"; the estimator itself is heuristic by nature | Try in the car; expect rough values, "—" for hybrids in EV mode |
| Live HTTPS on your own domain | Not deployed — I have no access to your hosting or GitHub account | README §1 (Netlify Drop takes about a minute) |

## Known limitations (by design, stated in the app)
- RPM is an estimate from cabin sound; it cannot read the engine computer and shows "—" rather than a guess
  when the signal is not clearly periodic. Hybrids in electric mode have no engine RPM to measure.
- The acoustic estimate needs the cylinder count (Settings on the Drive screen, default 4).
- Export on the claude.ai demo host is blocked by the sandbox; "Copy backup to clipboard" works there.
- Conflict resolution is last-write-wins per record using the device clock.
