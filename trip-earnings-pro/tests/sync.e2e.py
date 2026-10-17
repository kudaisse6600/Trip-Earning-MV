"""Sync-layer tests against an in-memory stand-in for supabase-js (tests/fake-supabase.js).
These prove the app's sync logic (push/pull, offline queue, reconnect, multi-device restore,
owner conflict, status badge, OAuth call shape). They do NOT prove a real Supabase project or
Google OAuth works — that needs the user's own project (see VERIFICATION.md)."""
import os, sys, json, time, threading, http.server, socketserver, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, 'public')
PORT = int(os.environ.get('PORT', 8792))
results = []
def check(name, cond, info=''):
    results.append((name, bool(cond), info)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if info and not cond else ''))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
def serve():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', PORT), functools.partial(Quiet, directory=PUB)) as h: h.serve_forever()
threading.Thread(target=serve, daemon=True).start(); time.sleep(0.4)
URL = f'http://127.0.0.1:{PORT}/index.html'
FAKE = open(os.path.join(ROOT, 'tests', 'fake-supabase.js')).read()
CFG = json.dumps({'url': 'https://test.supabase.co', 'anonKey': 'anon-key-for-tests-0123456789'})
USER_A = {'user': {'id': 'user-a', 'email': 'a@example.com', 'user_metadata': {'full_name': 'Driver A'}}}
USER_B = {'user': {'id': 'user-b', 'email': 'b@example.com', 'user_metadata': {'full_name': 'Driver B'}}}

with sync_playwright() as p:
    browser = p.chromium.launch()
    cloud_state = {'value': None}

    def new_device(session, cloud=None):
        ctx = browser.new_context(viewport={'width': 390, 'height': 800})
        ctx.route('https://fonts.googleapis.com/**', lambda r: r.abort())
        ctx.route('https://cdn.jsdelivr.net/**', lambda r: r.fulfill(status=200, content_type='application/javascript', body=FAKE))
        init = f"localStorage.setItem('tep.supabase', {json.dumps(CFG)}); window.__session = {json.dumps(session) if session else 'null'};"
        if cloud is not None: init += f"window.__cloud = {json.dumps(cloud)};"
        ctx.add_init_script(init)
        pg = ctx.new_page(); pg.goto(URL); pg.wait_for_selector('#routeGrid .route')
        return ctx, pg
    def get_cloud(pg): return pg.evaluate('window.__cloud')
    def badge(pg): return pg.text_content('#syncText')
    def wait_badge(pg, text, t=4000):
        if text == 'Synced': pg.wait_for_timeout(900)  # let the debounced sync start first
        pg.wait_for_function(f"document.getElementById('syncText').textContent === {json.dumps(text)} && (TESync.pendingCount() === 0 || {json.dumps(text)} !== 'Synced')", timeout=t)

    # --- Device 1: signed out, configured ---
    ctx1, d1 = new_device(None)
    wait_badge(d1, 'Not signed in')
    check('badge: Not signed in when configured but no session', badge(d1) == 'Not signed in')
    d1.click('#routeGrid .route:has-text("Ethere")')
    d1.click('nav button[data-view="settings"]'); d1.click('#signInBtn'); d1.wait_for_timeout(100)
    oauth = d1.evaluate('window.__oauthCalled')
    check('Sign in calls signInWithOAuth(provider=google) with redirect back to the app', oauth and oauth['provider'] == 'google' and oauth['options']['redirectTo'].startswith('http://127.0.0.1'), str(oauth))
    # Simulate OAuth returning a session for user A
    d1.evaluate(f"window.__sb.auth._setSession({json.dumps(USER_A)})")
    wait_badge(d1, 'Synced')
    check('badge: Synced after sign-in', badge(d1) == 'Synced')
    check('account name shown', d1.text_content('#acctName') == 'Driver A')
    cloud = get_cloud(d1)
    check('pre-sign-in local trip uploaded to cloud under user A', len(cloud['trips']) == 1 and cloud['trips'][0]['user_id'] == 'user-a')
    check('7 preset routes uploaded', len(cloud['routes']) == 7)
    check('profile (settings) uploaded', len(cloud['profiles']) == 1 and cloud['profiles'][0]['settings']['target'] == 1000)

    # --- Offline: add trips, badge says Offline, queue grows; reconnect pushes ---
    d1.click('nav button[data-view="today"]')
    d1.evaluate("window.__cloudDown = true; Object.defineProperty(navigator, 'onLine', {get: () => false, configurable: true}); window.dispatchEvent(new Event('offline'))")
    wait_badge(d1, 'Offline')
    d1.click('#routeGrid .route:has-text("P1 → P2")'); d1.click('#tipRow .tip:has-text("+ MVR 10")'); d1.wait_for_timeout(1200)
    check('badge stays Offline while offline', badge(d1) == 'Offline')
    pend = d1.evaluate('TESync.pendingCount()')
    check('2 changes queued while offline', pend == 2, pend)
    check('cloud untouched while offline', len(get_cloud(d1)['trips']) == 1)
    d1.evaluate("window.__cloudDown = false; Object.defineProperty(navigator, 'onLine', {get: () => true, configurable: true}); window.dispatchEvent(new Event('online'))")
    wait_badge(d1, 'Synced')
    check('reconnect flushes queue to cloud (3 trips)', len(get_cloud(d1)['trips']) == 3 and d1.evaluate('TESync.pendingCount()') == 0)

    # --- Sync failure badge ---
    d1.evaluate("window.__cloudDown = true")
    d1.click('#routeGrid .route:has-text("Ethere")')
    wait_badge(d1, 'Sync failed', 5000)
    check('badge: Sync failed when server errors while online', badge(d1) == 'Sync failed')
    d1.evaluate("window.__cloudDown = false"); d1.click('nav button[data-view="settings"]'); d1.click('#syncNowBtn'); wait_badge(d1, 'Synced')
    check('Sync now recovers', len(get_cloud(d1)['trips']) == 4)

    # Edit a route fare and delete a trip on device 1 → should propagate
    d1.click('#routeList .entry:has-text("Ethere") .del'); d1.fill('#rFare', '33'); d1.click('#shYes')
    d1.click('nav button[data-view="history"]'); d1.click('#histList .entry >> nth=0 >> .del'); d1.click('#shYes')
    wait_badge(d1, 'Synced'); d1.wait_for_timeout(300)
    cloud = get_cloud(d1)
    check('route edit reaches cloud', any(r['from_loc'] == 'Ethere' and r['fare'] == 33 for r in cloud['routes']))
    check('soft delete reaches cloud', sum(1 for t in cloud['trips'] if t['deleted']) == 1)

    # --- Device 2: same user, fresh browser → restore ---
    ctx2, d2 = new_device(USER_A, cloud)
    wait_badge(d2, 'Synced')
    check('device 2 restores 3 live trips from cloud', d2.text_content('#todayTrips') == '2' and d2.text_content('#todayTips') == '10', d2.text_content('#todayTrips') + '/' + d2.text_content('#todayTips'))
    fare = d2.text_content('#routeGrid .route:has(.n:text-is("Ethere")) .f')
    check('device 2 gets edited fare (MVR 33)', fare == 'MVR 33', fare)
    d2.click('nav button[data-view="history"]')
    check('device 2 hides the trip deleted on device 1', d2.locator('#histList .entry').count() == 3)
    # Change on device 2, then device 1 pulls on visibility
    d2.click('nav button[data-view="today"]'); d2.click('#routeGrid .route:has-text("P2 → Airport")'); wait_badge(d2, 'Synced')
    cloud = get_cloud(d2)
    d1.evaluate(f"Object.assign(window.__cloud, {json.dumps(cloud)})")  # separate contexts: hand the shared cloud back
    d1.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); d1.wait_for_timeout(1200)
    d1.click('nav button[data-view="today"]')
    check('device 1 pulls device 2 trip on refocus', d1.text_content('#todayTrips') == '3', d1.text_content('#todayTrips'))

    # --- Isolation: user B on a fresh device sees nothing of user A ---
    ctx3, d3 = new_device(USER_B, cloud)
    wait_badge(d3, 'Synced')
    check('user B sees 0 trips (row filter by user_id, as RLS enforces server-side)', d3.text_content('#todayTrips') == '0')
    d3.click('#routeGrid .route:has-text("Ethere")'); wait_badge(d3, 'Synced')
    cloud = get_cloud(d3)
    check("user B's trip stored under user B only", sum(1 for t in cloud['trips'] if t['user_id'] == 'user-b') == 1 and sum(1 for t in cloud['trips'] if t['user_id'] == 'user-a') == 5)

    # --- Owner conflict: user B signs in on device 1 (holds A's data) ---
    d1.evaluate(f"Object.assign(window.__cloud, {json.dumps(cloud)}); window.__sb.auth._setSession({json.dumps(USER_B)})")
    d1.wait_for_selector('#shMerge', timeout=3000)
    check('owner-conflict sheet appears when another account signs in on a device with data', d1.is_visible('#shDiscard'))
    d1.click('#shDiscard'); wait_badge(d1, 'Synced'); d1.wait_for_timeout(200)
    check("after discard, device 1 shows only user B's data (1 trip)", d1.text_content('#todayTrips') == '1', d1.text_content('#todayTrips'))
    cloud = get_cloud(d1)
    check("user A's cloud rows untouched by the discard", sum(1 for t in cloud['trips'] if t['user_id'] == 'user-a') == 5)

    # --- Sign out keeps local data ---
    d1.click('nav button[data-view="settings"]'); d1.click('#signOutBtn'); d1.click('#shYes'); wait_badge(d1, 'Not signed in')
    check('sign out: badge Not signed in, local trips kept', d1.evaluate("JSON.parse(localStorage.getItem('tep.state')).trips.filter(t=>!t.deleted).length") == 1)

    for c in (ctx1, ctx2, ctx3): c.close()
    browser.close()

passed = sum(1 for r in results if r[1]); total = len(results)
print(f'\n{passed}/{total} checks passed')
json.dump([{'check': n, 'pass': ok, 'info': i} for n, ok, i in results], open(os.path.join(ROOT, 'tests', 'sync-results.json'), 'w'), indent=2)
sys.exit(0 if passed == total else 1)
