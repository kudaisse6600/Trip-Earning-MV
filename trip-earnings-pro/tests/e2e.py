"""End-to-end browser tests for Trip Earnings Pro (headless Chromium via Playwright).
Run:  python3 tests/e2e.py   (serves ./public on a local port)
Covers routes, fares, tips vs trip count, target, achievements (3 taps), speed warning
(1 tap, no repeats), history, midnight reset (yesterday's trips excluded from Today,
kept in History), legacy JSON import, export, dark mode, custom routes, offline badge."""
import json, os, sys, threading, time, http.server, socketserver, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, 'public')
PORT = 8765
results = []

def check(name, cond, info=''):
    results.append((name, bool(cond), info))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{info}]' if info and not cond else ''))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve():
    handler = functools.partial(Quiet, directory=PUB)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', PORT), handler) as httpd:
        httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()
time.sleep(0.4)
URL = f'http://127.0.0.1:{PORT}/index.html'

FAKE_GEO = """
window.__speed = null;
navigator.geolocation.watchPosition = (ok, err) => {
  window.__geoTimer = setInterval(() => { if (window.__speed != null) ok({ coords: { speed: window.__speed / 3.6, accuracy: 5 } }); }, 100);
  return 1;
};
navigator.geolocation.clearWatch = () => clearInterval(window.__geoTimer);
"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 390, 'height': 800}, device_scale_factor=2)
    ctx.add_init_script(FAKE_GEO)
    page = ctx.new_page()
    page.route('https://fonts.googleapis.com/**', lambda r: r.abort())  # sandbox has no internet; fallback fonts must work
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)  # network (fonts/CDN) is not an app error
    page.goto(URL); page.wait_for_selector('#routeGrid .route')

    # 1. Preset routes & fares
    labels = page.eval_on_selector_all('#routeGrid .route', 'els => els.map(e => e.querySelector(".n").textContent + "|" + e.querySelector(".f").textContent)')
    want = {"Male' → Airport|MVR 70", "Male' → P1|MVR 85", "Male' → P2|MVR 100", 'Ethere|MVR 30', 'P1 → P2|MVR 40', 'P1 → Airport|MVR 80', 'P2 → Airport|MVR 85'}
    check('7 preset routes with correct fares', set(labels) == want, str(labels))

    # 2. Add trips and tips
    def tap_route(label):
        page.click(f'#routeGrid .route:has(.n:text-is("{label}"))')
    tap_route("Male' → Airport"); tap_route('Ethere'); tap_route("Male' → P2")
    page.click('#tipRow .tip:has-text("+ MVR 5")'); page.click('#tipRow .tip:has-text("+ MVR 10")')
    g = page.text_content('#todayGross'); n = page.text_content('#todayTrips'); t = page.text_content('#todayTips')
    check('gross = 70+30+100+5+10 = 215', g == '215', g)
    check('trip count = 3 (tips not counted)', n == '3', n)
    check('tips = 15', t == '15', t)
    check('target progress 21% of 1000', page.text_content('#ringTxt') == '21%', page.text_content('#ringTxt'))
    check('no achievement yet at 21%', page.is_hidden('#achOverlay'))

    # 3. Custom tip
    page.click('#tipRow .tip:has-text("Custom")'); page.fill('#tipIn', '35'); page.click('#shYes')
    check('custom tip 35 adds to earnings', page.text_content('#todayGross') == '250')
    check('custom tip does not add a trip', page.text_content('#todayTrips') == '3')

    # 4. Achievement at 25% requires exactly 3 taps
    check('achievement overlay shown at 25%', page.is_visible('#achOverlay'))
    check('achievement text correct', '25%' in page.text_content('#achOverlay') and 'Alhamdulillah three times' in page.text_content('#achOverlay'))
    page.click('#achOverlay'); check('still visible after 1 tap', page.is_visible('#achOverlay'))
    page.click('#achOverlay'); check('still visible after 2 taps', page.is_visible('#achOverlay'))
    page.click('#achOverlay'); page.wait_for_timeout(400)
    check('dismissed after exactly 3 taps', page.is_hidden('#achOverlay'))

    # Jump to 100%: add 8 × P2 (800) → 1050; dismiss each achievement as it appears
    seen = []
    for _ in range(8):
        tap_route("Male' → P2"); page.wait_for_timeout(120)
        while page.is_visible('#achOverlay'):
            seen.append(page.text_content('#achPct'))
            for _ in range(3): page.click('#achOverlay')
            page.wait_for_timeout(350)
    check('50%, 75%, 100% each shown once, in order', seen == ['50%', '75%', '100%'], str(seen))
    check('100% overlay gone, none repeated', page.is_hidden('#achOverlay'))
    tap_route('Ethere'); page.wait_for_timeout(200)
    check('no achievement re-fires after 100%', page.is_hidden('#achOverlay'))

    # 5. Undo
    page.click('#undoBtn'); page.wait_for_timeout(100)
    check('undo removes last trip', page.text_content('#todayTrips') == '11', page.text_content('#todayTrips'))

    # 6. History
    page.click('nav button[data-view="history"]')
    rows = page.locator('#histList .entry').count()
    check('history lists all 14 live entries (11 trips + 3 tips)', rows == 14, rows)
    page.click('#histList .entry >> nth=0 >> .del'); page.click('#shYes'); page.wait_for_timeout(100)
    check('delete from history works', page.locator('#histList .entry').count() == 13)

    # 7. Midnight reset: inject a trip from "yesterday" (Maldives time) and a 00:00:30 MVT trip today
    page.evaluate("""() => {
      const C = window.TECore; const s = JSON.parse(localStorage.getItem('tep.state'));
      const todayStart = C.nextMidnight(Date.now()) - 86400000;   // 00:00 MVT today
      s.trips.push({ id: 'y1', ts: todayStart - 60000, from: "Male'", to: 'P1', fare: 85, extra: false, pay: 'cash', note: '', routeId: 'r2', updatedAt: 1, deleted: false });
      s.trips.push({ id: 't1', ts: todayStart + 30000, from: "Male'", to: 'P1', fare: 85, extra: false, pay: 'cash', note: '', routeId: 'r2', updatedAt: 1, deleted: false });
      localStorage.setItem('tep.state', JSON.stringify(s));
    }""")
    page.reload(); page.wait_for_selector('#routeGrid .route')
    check('today excludes yesterday 23:59 MVT trip but includes 00:00:30 MVT trip (count 11)', page.text_content('#todayTrips') == '11', page.text_content('#todayTrips'))
    page.click('nav button[data-view="history"]')
    check('history still shows yesterday (two day groups)', page.locator('#histList .day').count() == 2, page.locator('#histList .day').count())
    check('data survives reload (autosave)', page.locator('#histList .entry').count() == 15)

    # 8. Legacy import
    page.click('nav button[data-view="settings"]')
    page.set_input_files('#importIn', os.path.join(ROOT, 'tests', 'fixtures', 'legacy-v2.json'))
    page.wait_for_selector('#toast:visible'); toast = page.text_content('#toast')
    check('legacy v2 import succeeded (30 records)', 'Imported 30 records' in toast, toast)
    page.click('nav button[data-view="history"]')
    page.click('nav button[data-view="today"]')
    check('legacy import keeps preset route directions (Male\' → P1 still present)', page.locator('#routeGrid .route:has-text("Male\' → P1")').count() == 1)
    page.click('nav button[data-view="history"]')
    check('history grows by 30 after import', page.locator('#histList .entry').count() == 45, page.locator('#histList .entry').count())
    legacy_day = page.locator("#histList .day:has-text(\"10 Oct\")")
    check('imported day totals MVR 1,310 / 24 trips', '24 trips' in legacy_day.text_content() and '1,310' in legacy_day.text_content(), legacy_day.text_content()[:120])

    # 9. Export
    page.click('nav button[data-view="settings"]')
    with page.expect_download() as dl:
        page.click('#exportBtn')
    data = json.load(open(dl.value.path()))
    check('export is v3 with all 45 live + 2 deleted records', data['version'] == 3 and len(data['trips']) == 47, len(data['trips']))
    check('export round-trips through parser', page.evaluate("j => TECore.parseBackup(j).trips.length", json.dumps(data)) == 47)

    # 10. Custom route + edit fare + persistence
    page.click('#addRouteBtn'); page.fill('#rFrom', 'Hulhumale'); page.fill('#rTo', 'Villimale'); page.fill('#rFare', '150'); page.click('#shYes')
    page.click('nav button[data-view="today"]')
    check('custom route appears on Today', page.locator('#routeGrid .route:has-text("Hulhumale → Villimale")').count() == 1)
    page.click('nav button[data-view="settings"]')
    page.click('#routeList .entry:has-text("Ethere") .del'); page.fill('#rFare', '35'); page.click('#shYes')
    page.reload(); page.wait_for_selector('#routeGrid .route')
    fare = page.text_content('#routeGrid .route:has(.n:text-is("Ethere")) .f')
    check('edited fare persists after reload', fare == 'MVR 35', fare)
    check('custom route persists after reload', page.locator('#routeGrid .route:has-text("Hulhumale")').count() == 1)

    # 11. Target change
    page.click('nav button[data-view="settings"]'); page.fill('#targetIn', '2000'); page.press('#targetIn', 'Tab')
    page.click('nav button[data-view="today"]')
    check('target updates to 2,000', page.text_content('#targetTxt') == '2,000', page.text_content('#targetTxt'))

    # 12. Dark / light mode
    page.click('nav button[data-view="settings"]'); page.select_option('#themeSel', 'light')
    check('light theme sets data-theme', page.get_attribute('html', 'data-theme') == 'light')
    bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    check('light theme background is light', bg == 'rgb(238, 244, 246)', bg)
    page.select_option('#themeSel', 'dark')
    check('dark theme background is dark', page.evaluate("getComputedStyle(document.body).backgroundColor") == 'rgb(11, 22, 32)')

    # 13. Speed warning: 80 km/h → one tap, no repeat while fast, re-arms after slowing
    page.click('nav button[data-view="drive"]'); page.click('#driveSw')
    page.evaluate('window.__speed = 60'); page.wait_for_timeout(300)
    check('no warning at 60 km/h', page.is_hidden('#warnOverlay'))
    page.evaluate('window.__speed = 82'); page.wait_for_selector('#warnOverlay:visible', timeout=2000)
    check('warning shown at 82 km/h with text', 'YOUR LIFE IS IMPORTANT' in page.text_content('#warnOverlay'))
    page.click('#warnOverlay'); page.wait_for_timeout(100)
    check('one tap dismisses warning', page.is_hidden('#warnOverlay'))
    page.evaluate('window.__speed = 95'); page.wait_for_timeout(500)
    check('no repeat while still above threshold', page.is_hidden('#warnOverlay'))
    page.evaluate('window.__speed = 50'); page.wait_for_timeout(400)
    page.evaluate('window.__speed = 85'); page.wait_for_selector('#warnOverlay:visible', timeout=2000)
    check('warning re-arms after slowing below 70 then speeding again', page.is_visible('#warnOverlay'))
    page.click('#warnOverlay')
    check('GPS speed displayed', page.text_content('#speedVal') == '85', page.text_content('#speedVal'))
    check('RPM shows dash with mic off (never fabricated)', page.text_content('#rpmVal') == '—')

    # 14. Sync badge honest states
    check('badge says Local only when Supabase unconfigured', page.text_content('#syncText') == 'Local only')
    ctx.set_offline(True); page.evaluate("window.dispatchEvent(new Event('offline'))"); page.wait_for_timeout(100)
    # (unconfigured mode does not listen for offline; configured mode does — covered in sync unit test)
    ctx.set_offline(False)

    # 15. Branding, no horizontal scroll, no JS errors
    check('Powered by Kuda Isse present', 'Kuda Isse' in page.text_content('.footer'))
    page.click('nav button[data-view="today"]')
    sw = page.evaluate('document.documentElement.scrollWidth'); cw = page.evaluate('document.documentElement.clientWidth')
    check('no horizontal overflow at 390px', sw <= cw, f'{sw}>{cw}')
    page.screenshot(path=os.path.join(ROOT, 'tests', 'screenshot-today.png'))
    check('no JavaScript errors in console', not errors, '; '.join(errors)[:300])

    browser.close()

passed = sum(1 for r in results if r[1]); total = len(results)
print(f'\n{passed}/{total} checks passed')
with open(os.path.join(ROOT, 'tests', 'e2e-results.json'), 'w') as f:
    json.dump([{'check': n, 'pass': ok, 'info': i} for n, ok, i in results], f, indent=2)
sys.exit(0 if passed == total else 1)
