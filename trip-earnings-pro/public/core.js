/* Trip Earnings Pro — core logic (pure functions, no DOM).
   Loaded by the browser as a plain script and by Node tests via require(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TECore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MALDIVES_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5, no DST
  const CURRENCY = 'MVR';
  const ACHIEVEMENTS = [25, 50, 75, 100];
  const SPEED_WARN_KMH = 80;
  const SPEED_CLEAR_KMH = 70; // hysteresis so the warning doesn't flap

  // Preset routes. Fares are editable; presets are seeded once.
  const PRESET_ROUTES = [
    { id: 'r6', from: "Male'", to: 'Airport', fare: 70 },
    { id: 'r2', from: "Male'", to: 'P1', fare: 85 },
    { id: 'r3', from: "Male'", to: 'P2', fare: 100 },
    { id: 'r7', from: 'Ethere', to: '', fare: 30 },
    { id: 'r1', from: 'P1', to: 'P2', fare: 40 },
    { id: 'r4', from: 'P1', to: 'Airport', fare: 80 },
    { id: 'r5', from: 'P2', to: 'Airport', fare: 85 },
  ];
  const PRESET_TIPS = [5, 10];

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /** YYYY-MM-DD for a timestamp, in Maldives local time (UTC+5). */
  function dayKey(ts) {
    return new Date(ts + MALDIVES_OFFSET_MS).toISOString().slice(0, 10);
  }

  /** Epoch ms of the next Maldives midnight after ts. */
  function nextMidnight(ts) {
    const shifted = ts + MALDIVES_OFFSET_MS;
    const dayStart = Math.floor(shifted / 86400000) * 86400000;
    return dayStart + 86400000 - MALDIVES_OFFSET_MS;
  }

  function routeLabel(r) {
    return r.to ? `${r.from} → ${r.to}` : r.from;
  }

  function makeTrip(route, now, pay) {
    return {
      id: uuid(), ts: now, from: route.from, to: route.to || '',
      fare: Number(route.fare), extra: false, pay: pay || 'cash', note: '',
      routeId: route.id || null, updatedAt: now, deleted: false,
    };
  }

  function makeTip(amount, now, pay) {
    return {
      id: uuid(), ts: now, from: 'Tip', to: '', fare: Number(amount),
      extra: true, pay: pay || 'cash', note: '', routeId: null,
      updatedAt: now, deleted: false,
    };
  }

  /** Totals for one day. Tips count toward earnings, never toward trips. */
  function dayTotals(trips, key) {
    let gross = 0, tips = 0, count = 0;
    for (const t of trips) {
      if (t.deleted || dayKey(t.ts) !== key) continue;
      const f = Number(t.fare) || 0;
      gross += f;
      if (t.extra) tips += f; else count += 1;
    }
    return { gross, tips, fares: gross - tips, count };
  }

  function pct(gross, target) {
    if (!target || target <= 0) return 0;
    return Math.min(100, Math.floor((gross / target) * 100));
  }

  /** Which achievement thresholds are newly crossed (ascending). */
  function newAchievements(percent, alreadyShown) {
    const shown = new Set(alreadyShown || []);
    return ACHIEVEMENTS.filter((a) => percent >= a && !shown.has(a));
  }

  /** Speed-warning state machine. Returns next state and whether to show. */
  function speedStep(state, kmh) {
    // state: { armed: bool } — armed means a warning may be shown.
    if (kmh == null || Number.isNaN(kmh)) return { state, show: false };
    if (state.armed && kmh >= SPEED_WARN_KMH) return { state: { armed: false }, show: true };
    if (!state.armed && kmh < SPEED_CLEAR_KMH) return { state: { armed: true }, show: false };
    return { state, show: false };
  }

  /** Per-day series for the last n days ending at `now`. */
  function dailySeries(trips, now, n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const key = dayKey(now - i * 86400000);
      out.push({ key, ...dayTotals(trips, key) });
    }
    return out;
  }

  function routeBreakdown(trips, fromTs, toTs) {
    const map = new Map();
    for (const t of trips) {
      if (t.deleted || t.extra || t.ts < fromTs || t.ts > toTs) continue;
      const label = routeLabel(t);
      const e = map.get(label) || { label, count: 0, total: 0 };
      e.count++; e.total += Number(t.fare) || 0;
      map.set(label, e);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }

  /* ---------- Import / export ---------- */

  function normalizeTrip(t) {
    const extra = !!t.extra || t.from === 'Tip';
    return {
      id: String(t.id || uuid()),
      ts: Number(t.ts) || Date.now(),
      from: extra ? 'Tip' : String(t.from || ''),
      to: extra ? '' : String(t.to || ''),
      fare: Number(t.fare) || 0,
      extra,
      pay: t.pay || 'cash',
      note: t.note || '',
      routeId: t.routeId || t.route_id || null,
      updatedAt: Number(t.updatedAt || t.updated_at) || Number(t.ts) || Date.now(),
      deleted: !!t.deleted,
    };
  }

  function normalizeRoute(r) {
    // Legacy "In → In" was the old name for Ethere; "Hulhule" for Airport.
    let from = String(r.from || ''), to = String(r.to || '');
    if (from === 'In' && to === 'In') { from = 'Ethere'; to = ''; }
    if (to === 'Hulhule') to = 'Airport';
    if (from === 'Hulhule') from = 'Airport';
    return {
      id: String(r.id || uuid()), from, to, fare: Number(r.fare) || 0,
      updatedAt: Number(r.updatedAt || r.updated_at) || Date.now(), deleted: !!r.deleted,
    };
  }

  /**
   * Parse a backup (v2 legacy "Trip Earnings" export or v3 Pro export).
   * Returns { routes, trips, settings, celebrated } or throws.
   */
  function parseBackup(json) {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    if (!d || typeof d !== 'object' || !Array.isArray(d.trips)) throw new Error('Not a Trip Earnings backup');
    const routes = (d.routes || [])
      .filter((r) => !r.extra && r.from !== 'Extra') // legacy tip pseudo-routes become presets
      .map(normalizeRoute);
    const trips = d.trips.map(normalizeTrip);
    const settings = d.settings && typeof d.settings === 'object' ? d.settings : {};
    const celebrated = d.celebrated && typeof d.celebrated === 'object' ? d.celebrated : {};
    return { version: Number(d.version) || 2, routes, trips, settings, celebrated };
  }

  function makeBackup(state, now) {
    return {
      version: 3, app: 'Trip Earnings Pro', currency: CURRENCY,
      exportedAt: new Date(now).toISOString(),
      routes: state.routes, trips: state.trips, settings: state.settings,
      celebrated: state.celebrated || {},
    };
  }

  /** Merge two record lists by id, last write (updatedAt) wins. */
  function mergeById(local, remote) {
    const map = new Map();
    for (const r of local) map.set(r.id, r);
    for (const r of remote) {
      const cur = map.get(r.id);
      if (!cur || (r.updatedAt || 0) >= (cur.updatedAt || 0)) map.set(r.id, r);
    }
    return [...map.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  }

  /** RPM from a detected fundamental firing frequency (Hz). 4-stroke: firings/s = rpm/60 * cyl/2. */
  function rpmFromFiringHz(hz, cylinders) {
    if (!hz || !cylinders) return null;
    return Math.round((hz * 60 * 2) / cylinders);
  }

  return {
    MALDIVES_OFFSET_MS, CURRENCY, ACHIEVEMENTS, SPEED_WARN_KMH, SPEED_CLEAR_KMH,
    PRESET_ROUTES, PRESET_TIPS, uuid, dayKey, nextMidnight, routeLabel,
    makeTrip, makeTip, dayTotals, pct, newAchievements, speedStep, dailySeries,
    routeBreakdown, parseBackup, makeBackup, mergeById, normalizeTrip, normalizeRoute,
    rpmFromFiringHz,
  };
});
