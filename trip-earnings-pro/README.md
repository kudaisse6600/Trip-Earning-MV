# Trip Earnings Pro

Mobile-first trip and tip tracker for Male' taxi drivers. Static HTML/CSS/JS, installable as a PWA,
offline-first, with optional Google sign-in and cloud sync through **your own** Supabase project.

```
public/               ← the whole website (deploy this folder as-is)
  index.html          UI + styles
  app.js              screens, achievements, speed warning, GPS, acoustic RPM, import/export
  core.js             pure logic (fares, UTC+5 day boundaries, totals, merge) — also used by tests
  sync.js             Supabase Auth (Google OAuth) + offline queue + last-write-wins sync
  sw.js               service worker (app shell cache; never caches Supabase traffic)
  manifest.webmanifest, icon.svg, icon-192.png, icon-512.png
supabase/schema.sql   tables + Row Level Security policies
tests/                node unit tests, Playwright browser tests, sync tests, real-Postgres RLS test
VERIFICATION.md       what was tested, how, and what still needs your credentials
```

No build step. No secrets in the frontend: the only key the browser ever holds is the Supabase
**anon** key, which is designed to be public and is powerless without a signed-in user once RLS is on.

---

## 1. Deploy the website (HTTPS)

Any static host works. Three options, easiest first:

**Netlify Drop (no account tools needed, ~1 minute)**
1. Go to https://app.netlify.com/drop
2. Drag the `public/` folder onto the page. You get an `https://<name>.netlify.app` URL immediately.
3. (Optional) Site settings → Change site name, or add a custom domain.

**Cloudflare Pages / Vercel**: create a project, upload or connect a repo, set the output directory to `public`.

**GitHub Pages**: push this repo, Settings → Pages → Deploy from branch → folder `/public` (or move the files to the repo root). Note the URL will have a path, e.g. `https://you.github.io/trip-earnings-pro/`; use that exact URL in the OAuth settings below.

Whatever you choose, note the final URL — call it `APP_URL`. HTTPS is required for GPS, microphone, PWA install and OAuth.

## 2. Create the Supabase project and database

1. https://supabase.com → New project (free tier is fine). Pick a region near you (Singapore or Mumbai).
2. Dashboard → **SQL Editor** → New query → paste the contents of `supabase/schema.sql` → **Run**.
   You should see "Success. No rows returned".
3. Dashboard → **Project Settings → API**: copy the **Project URL** and the **anon public** key.
   Never copy the `service_role` key anywhere near the frontend.

## 3. Configure Google sign-in (OAuth)

**In Google Cloud Console** (https://console.cloud.google.com):
1. Create a project (or reuse one). APIs & Services → **OAuth consent screen** → External → fill the app name
   ("Trip Earnings Pro"), support email, developer email → Save. Add yourself under *Test users* while in Testing,
   or click *Publish app* so any Google account can sign in.
2. APIs & Services → **Credentials** → Create credentials → **OAuth client ID** → type **Web application**.
   - *Authorised JavaScript origins*: `APP_URL`'s origin, e.g. `https://trip-earnings.netlify.app`
   - *Authorised redirect URIs*: `https://<your-project-ref>.supabase.co/auth/v1/callback`
     (the exact value is shown in Supabase under Authentication → Providers → Google as "Callback URL").
3. Copy the **Client ID** and **Client secret**.

**In Supabase**:
4. Authentication → **Providers** → Google → enable → paste Client ID and Client secret → Save.
5. Authentication → **URL Configuration**:
   - *Site URL*: `APP_URL`
   - *Redirect URLs*: add `APP_URL` (and `APP_URL/index.html`, and `http://localhost:8000` if you want local testing).

## 4. Connect the app

Open `APP_URL` → **Settings → Supabase setup** → paste Project URL and anon key → Save & reload →
**Sign in with Google**. The badge at the top right shows the live state:

| Badge | Meaning |
|---|---|
| Local only | No Supabase configured; everything stays in this browser |
| Not signed in | Configured, waiting for Google sign-in |
| Online / Syncing… / Synced | Signed in; last sync time is under Settings |
| Offline | No network; changes queue (count shown under Settings → Pending changes) and upload automatically on reconnect |
| Sync failed | Server rejected or network dropped mid-sync; tap the badge or "Sync now" to retry |
| Needs attention | Another Google account's data is on this device; a sheet asks whether to merge or discard |

Signing in on a second device restores everything after the first sync. Devices also re-sync whenever the app
regains focus and every 60 seconds while open.

## 5. Importing from the old Trip Earnings app

Settings → **Import JSON** accepts the original app's `trip-earnings-backup-*.json` (version 2). `In → In` becomes
`Ethere`, `Hulhule` becomes `Airport`, legacy "Extra" tip pseudo-routes become the tip buttons. Records merge by id;
nothing already on the device is overwritten unless the import is newer.

## 6. Run the tests

```
node --test tests/core.test.js        # 12 unit tests on the pure logic
python3 tests/e2e.py                  # 46 browser checks (needs: pip install playwright && playwright install chromium)
python3 tests/sync.e2e.py             # 25 sync checks against an in-memory Supabase stand-in
bash tests/rls.test.sh                # applies schema.sql to a throwaway PostgreSQL 16 and proves user isolation
```

## 7. Local development

```
cd public && python3 -m http.server 8000
```
GPS, microphone and the service worker work on `http://localhost`; the Google sign-in works there only if you added
`http://localhost:8000` to Supabase's Redirect URLs.

## 8. Releasing an update

Edit files in `public/`, bump `CACHE` in `sw.js` (so installed PWAs refresh), redeploy the folder.

---
Powered by Kuda Isse.
