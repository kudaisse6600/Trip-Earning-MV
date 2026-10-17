const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../public/core.js');

const H = 3600000;

test('preset routes and fares match the spec', () => {
  const want = {
    "Male' → Airport": 70, "Male' → P1": 85, "Male' → P2": 100, 'Ethere': 30,
    'P1 → P2': 40, 'P1 → Airport': 80, 'P2 → Airport': 85,
  };
  const got = Object.fromEntries(C.PRESET_ROUTES.map((r) => [C.routeLabel(r), r.fare]));
  assert.deepEqual(got, want);
  assert.deepEqual(C.PRESET_TIPS, [5, 10]);
});

test('dayKey uses Maldives time (UTC+5), midnight boundary', () => {
  // 2026-10-16 18:59:59.999Z == 23:59:59.999 MVT
  const before = Date.UTC(2026, 9, 16, 18, 59, 59, 999);
  const after = before + 1; // 00:00:00.000 MVT on Oct 17
  assert.equal(C.dayKey(before), '2026-10-16');
  assert.equal(C.dayKey(after), '2026-10-17');
  assert.equal(C.nextMidnight(before), after);
  assert.equal(C.nextMidnight(after), after + 24 * H);
});

test('tips increase earnings but never trip count; midnight reset preserves history', () => {
  const t0 = Date.UTC(2026, 9, 16, 10, 0, 0); // 15:00 MVT Oct 16
  const trips = [
    C.makeTrip(C.PRESET_ROUTES[0], t0),            // 70
    C.makeTrip(C.PRESET_ROUTES[3], t0 + 1000),     // 30
    C.makeTip(5, t0 + 2000), C.makeTip(10, t0 + 3000),
    C.makeTrip(C.PRESET_ROUTES[2], t0 + 10 * H),   // 100 — 01:00 MVT Oct 17 (next day)
  ];
  const d16 = C.dayTotals(trips, '2026-10-16');
  assert.deepEqual(d16, { gross: 115, tips: 15, fares: 100, count: 2 });
  const d17 = C.dayTotals(trips, '2026-10-17');
  assert.deepEqual(d17, { gross: 100, tips: 0, fares: 100, count: 1 });
  // Nothing was lost: history still has all 5 records.
  assert.equal(trips.filter((t) => !t.deleted).length, 5);
});

test('custom tip amount works', () => {
  const tip = C.makeTip(37.5, 1000);
  assert.equal(tip.extra, true);
  assert.equal(tip.fare, 37.5);
  assert.equal(C.dayTotals([tip], C.dayKey(1000)).count, 0);
});

test('target progress and achievements fire once per threshold, in order', () => {
  assert.equal(C.pct(0, 1000), 0);
  assert.equal(C.pct(249, 1000), 24);
  assert.equal(C.pct(250, 1000), 25);
  assert.equal(C.pct(1500, 1000), 100);
  assert.equal(C.pct(500, 0), 0);
  assert.deepEqual(C.newAchievements(24, []), []);
  assert.deepEqual(C.newAchievements(25, []), [25]);
  assert.deepEqual(C.newAchievements(80, [25]), [50, 75]); // skipped thresholds still shown
  assert.deepEqual(C.newAchievements(100, [25, 50, 75]), [100]);
  assert.deepEqual(C.newAchievements(100, [25, 50, 75, 100]), []);
});

test('speed warning shows once at 80 km/h and re-arms only below 70', () => {
  let s = { armed: true };
  let r = C.speedStep(s, 79); assert.equal(r.show, false);
  r = C.speedStep(r.state, 80); assert.equal(r.show, true);
  r = C.speedStep(r.state, 95); assert.equal(r.show, false); // no repeat while fast
  r = C.speedStep(r.state, 75); assert.equal(r.show, false); // hysteresis band
  r = C.speedStep(r.state, 60); assert.equal(r.show, false); assert.equal(r.state.armed, true);
  r = C.speedStep(r.state, 81); assert.equal(r.show, true);
  r = C.speedStep(r.state, null); assert.equal(r.show, false);
});

test('legacy v2 backup imports: 30 records, legacy names normalised, tip pseudo-routes dropped', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-v2.json'), 'utf8');
  const b = C.parseBackup(raw);
  assert.equal(b.trips.length, 30);
  assert.equal(b.trips.filter((t) => t.extra).length, 6);
  const labels = b.routes.map(C.routeLabel);
  assert.ok(labels.includes('Ethere'));
  assert.ok(labels.includes("Male' → Airport"));
  assert.ok(!labels.some((l) => l.startsWith('Extra')) || labels.includes('Extra → .'));
  assert.ok(!b.routes.some((r) => r.fare === 10 || r.fare === 5));
  assert.equal(b.settings.target, 1000);
  // Totals for Oct 11 2026 MVT
  const key = C.dayKey(b.trips[0].ts);
  const tot = C.dayTotals(b.trips, key);
  assert.equal(tot.gross, 1310);
  assert.equal(tot.tips, 50);
  assert.equal(tot.count, 24);
});

test('export then import round-trips', () => {
  const state = {
    routes: C.PRESET_ROUTES.map((r) => ({ ...r, updatedAt: 1, deleted: false })),
    trips: [C.makeTrip(C.PRESET_ROUTES[1], 5000), C.makeTip(10, 6000)],
    settings: { target: 1200, theme: 'dark' }, celebrated: { '2026-10-16': [25] },
  };
  const json = JSON.stringify(C.makeBackup(state, 7000));
  const back = C.parseBackup(json);
  assert.equal(back.version, 3);
  assert.deepEqual(back.trips, state.trips);
  assert.equal(back.routes.length, 7);
  assert.equal(back.settings.target, 1200);
});

test('parseBackup rejects garbage', () => {
  assert.throws(() => C.parseBackup('{"hello":1}'));
  assert.throws(() => C.parseBackup('not json'));
});

test('mergeById: last write wins, deletes propagate', () => {
  const local = [{ id: 'a', ts: 1, fare: 10, updatedAt: 5 }, { id: 'b', ts: 2, fare: 20, updatedAt: 5 }];
  const remote = [{ id: 'a', ts: 1, fare: 11, updatedAt: 9 }, { id: 'b', ts: 2, fare: 21, updatedAt: 3 }, { id: 'c', ts: 3, fare: 30, updatedAt: 1, deleted: true }];
  const m = C.mergeById(local, remote);
  assert.equal(m.find((r) => r.id === 'a').fare, 11);
  assert.equal(m.find((r) => r.id === 'b').fare, 20);
  assert.equal(m.find((r) => r.id === 'c').deleted, true);
});

test('rpm conversion is honest arithmetic only', () => {
  assert.equal(C.rpmFromFiringHz(30, 4), 900);   // 4-cyl idle: 30 Hz ≈ 900 rpm
  assert.equal(C.rpmFromFiringHz(100, 4), 3000);
  assert.equal(C.rpmFromFiringHz(0, 4), null);
  assert.equal(C.rpmFromFiringHz(50, 0), null);
});

test('daily series and route breakdown', () => {
  const now = Date.UTC(2026, 9, 17, 6, 0, 0);
  const trips = [C.makeTrip(C.PRESET_ROUTES[0], now - 24 * H), C.makeTrip(C.PRESET_ROUTES[0], now), C.makeTip(5, now)];
  const s = C.dailySeries(trips, now, 3);
  assert.equal(s.length, 3);
  assert.equal(s[2].gross, 75);
  assert.equal(s[1].gross, 70);
  const b = C.routeBreakdown(trips, 0, now);
  assert.deepEqual(b, [{ label: "Male' → Airport", count: 2, total: 140 }]);
});
