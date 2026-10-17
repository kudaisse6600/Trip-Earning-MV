/* Trip Earnings Pro — UI and state. Depends on core.js and sync.js. */
(function () {
  'use strict';
  const C = window.TECore, S = window.TESync;
  const STATE_KEY = 'tep.state';
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('en-US');
  const now = () => Date.now();

  /* ---------------- state ---------------- */
  const defaults = () => ({
    routes: C.PRESET_ROUTES.map((r) => ({ ...r, updatedAt: 1, deleted: false })),
    trips: [],
    settings: { target: 1000, celebrate: true, haptics: true, theme: 'system', pay: 'cash', cylinders: 4 },
    celebrated: {}, // dayKey -> [25, 50]
    profileUpdatedAt: 1,
  });
  let state = load();
  function load() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return defaults();
      const s = JSON.parse(raw);
      const d = defaults();
      return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
    } catch (e) { return defaults(); }
  }
  function save() {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { toast('Could not save locally — storage is full or blocked'); }
  }
  function commit(table, id) { save(); S.markDirty(table, id); render(); }
  function commitProfile() { state.profileUpdatedAt = now(); save(); S.markDirty('profile'); render(); }

  const liveRoutes = () => state.routes.filter((r) => !r.deleted).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.from.localeCompare(b.from));
  const liveTrips = () => state.trips.filter((t) => !t.deleted);

  /* ---------------- actions ---------------- */
  let lastAdded = null;
  function addTrip(route) {
    const t = C.makeTrip(route, now(), state.settings.pay);
    state.trips.push(t); lastAdded = t;
    buzz(30);
    commit('trips', t.id);
    showUndo(`${C.routeLabel(route)} · MVR ${fmt(t.fare)} added`);
    checkAchievements();
  }
  function addTip(amount) {
    if (!(amount > 0)) return;
    const t = C.makeTip(amount, now(), state.settings.pay);
    state.trips.push(t); lastAdded = t;
    buzz(20);
    commit('trips', t.id);
    showUndo(`Tip MVR ${fmt(amount)} added`);
    checkAchievements();
  }
  function deleteTrip(id) {
    const t = state.trips.find((x) => x.id === id);
    if (!t) return;
    t.deleted = true; t.updatedAt = now();
    commit('trips', id);
    toast('Removed');
  }
  function undo() {
    if (!lastAdded) return;
    deleteTrip(lastAdded.id); lastAdded = null; $('undoBox').hidden = true;
  }
  let undoTimer;
  function showUndo(text) {
    $('undoText').textContent = text; $('undoBox').hidden = false;
    clearTimeout(undoTimer); undoTimer = setTimeout(() => { $('undoBox').hidden = true; }, 8000);
  }
  function buzz(ms) { if (state.settings.haptics && navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} } }

  /* ---------------- achievements (3 taps) ---------------- */
  const achQueue = [];
  let achTaps = 0, achOpen = false;
  function checkAchievements() {
    if (!state.settings.celebrate) return;
    const key = C.dayKey(now());
    const tot = C.dayTotals(state.trips, key);
    const p = C.pct(tot.gross, state.settings.target);
    const shown = state.celebrated[key] || [];
    const fresh = C.newAchievements(p, shown);
    if (!fresh.length) return;
    state.celebrated[key] = [...shown, ...fresh];
    Object.keys(state.celebrated).forEach((k) => { if (k < C.dayKey(now() - 7 * 86400000)) delete state.celebrated[k]; });
    commitProfile();
    achQueue.push(...fresh);
    if (!achOpen) nextAch();
  }
  function nextAch() {
    const p = achQueue.shift();
    if (p == null) { achOpen = false; $('achOverlay').hidden = true; return; }
    achOpen = true; achTaps = 0;
    $('achPct').textContent = p + '%'; $('achPct2').textContent = p;
    [1, 2, 3].forEach((i) => $('tap' + i).classList.remove('on'));
    $('achHint').textContent = 'Tap 3 times to continue';
    $('achOverlay').hidden = false;
    buzz([60, 40, 60]);
  }
  $('achOverlay').addEventListener('click', () => {
    achTaps++;
    for (let i = 1; i <= 3; i++) $('tap' + i).classList.toggle('on', i <= achTaps);
    const left = 3 - achTaps;
    $('achHint').textContent = left > 0 ? `Tap ${left} more time${left === 1 ? '' : 's'}` : 'Alhamdulillah';
    if (achTaps >= 3) setTimeout(nextAch, 250);
  });

  /* ---------------- speed warning (1 tap, no flapping) ---------------- */
  let speedState = { armed: true };
  function onSpeed(kmh) {
    const r = C.speedStep(speedState, kmh);
    speedState = r.state;
    if (r.show) { $('warnSpeed').textContent = Math.round(kmh); $('warnOverlay').hidden = false; buzz([200, 100, 200]); }
  }
  $('warnOverlay').addEventListener('click', () => { $('warnOverlay').hidden = true; });

  /* ---------------- render ---------------- */
  function render() {
    applyTheme();
    const key = C.dayKey(now());
    const tot = C.dayTotals(state.trips, key);
    const target = state.settings.target || 0;
    const p = C.pct(tot.gross, target);
    $('todayLabel').textContent = 'Today · ' + fmtDay(key);
    $('todayGross').textContent = fmt(tot.gross);
    $('todayTrips').textContent = tot.count;
    $('todayTips').textContent = fmt(tot.tips);
    $('todayFares').textContent = fmt(tot.fares);
    $('targetTxt').textContent = fmt(target);
    $('remainTxt').textContent = tot.gross >= target ? 'target reached' : fmt(target - tot.gross) + ' to go';
    $('barFill').style.width = p + '%';
    $('ringP').style.strokeDashoffset = String(226.2 * (1 - p / 100));
    $('ringTxt').textContent = p + '%';

    // route grid
    const grid = $('routeGrid'); grid.innerHTML = '';
    for (const r of liveRoutes()) {
      const b = document.createElement('button'); b.className = 'route'; b.type = 'button';
      b.innerHTML = `<span class="n"></span><span class="f num"></span>`;
      b.querySelector('.n').textContent = C.routeLabel(r);
      b.querySelector('.f').textContent = 'MVR ' + fmt(r.fare);
      b.addEventListener('click', () => addTrip(r));
      grid.appendChild(b);
    }
    const tips = $('tipRow'); tips.innerHTML = '';
    for (const a of C.PRESET_TIPS) {
      const b = document.createElement('button'); b.className = 'tip num'; b.type = 'button'; b.textContent = '+ MVR ' + a;
      b.addEventListener('click', () => addTip(a)); tips.appendChild(b);
    }
    const cb = document.createElement('button'); cb.className = 'tip'; cb.type = 'button'; cb.textContent = 'Custom tip…';
    cb.addEventListener('click', customTipSheet); tips.appendChild(cb);

    renderHistory(); renderInsights(); renderSettings();
  }
  function fmtDay(key) {
    const d = new Date(key + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Indian/Maldives' });
  }

  function renderHistory() {
    const list = $('histList'); list.innerHTML = '';
    const trips = liveTrips().sort((a, b) => b.ts - a.ts);
    $('histCount').textContent = trips.length ? `${trips.filter((t) => !t.extra).length} trips · ${trips.filter((t) => t.extra).length} tips` : '';
    if (!trips.length) { list.innerHTML = '<div class="card note">No trips yet. Tap a route on Today to add your first one.</div>'; return; }
    const groups = new Map();
    for (const t of trips) { const k = C.dayKey(t.ts); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
    let shown = 0;
    for (const [k, items] of groups) {
      if (shown++ > 60) break;
      const tot = C.dayTotals(items, k);
      const day = document.createElement('div'); day.className = 'day';
      const h = document.createElement('h3');
      h.innerHTML = `<span></span><span class="num">${tot.count} trips · MVR ${fmt(tot.gross)}${tot.tips ? ` (tips ${fmt(tot.tips)})` : ''}</span>`;
      h.firstChild.textContent = k === C.dayKey(now()) ? 'Today' : fmtDay(k);
      day.appendChild(h);
      for (const t of items) {
        const e = document.createElement('div'); e.className = 'entry' + (t.extra ? ' tipr' : '');
        e.innerHTML = `<span class="time num"></span><span class="n"></span><span class="amt num"></span><button class="del" aria-label="Remove">×</button>`;
        e.querySelector('.time').textContent = fmtTime(t.ts);
        e.querySelector('.n').textContent = t.extra ? 'Tip' : C.routeLabel(t);
        e.querySelector('.amt').textContent = (t.extra ? '+' : '') + fmt(t.fare);
        e.querySelector('.del').addEventListener('click', () => confirmSheet('Remove this entry?', `${t.extra ? 'Tip' : C.routeLabel(t)} · MVR ${fmt(t.fare)} at ${fmtTime(t.ts)}`, () => deleteTrip(t.id)));
        day.appendChild(e);
      }
      list.appendChild(day);
    }
  }

  function renderInsights() {
    const n = now();
    const s = C.dailySeries(state.trips, n, 14);
    const target = state.settings.target || 0;
    const max = Math.max(target, ...s.map((d) => d.gross), 1);
    const W = 360, H = 180, padL = 36, padB = 22, padT = 10, cw = (W - padL - 8) / 14;
    let svg = '';
    const ticks = niceTicks(max);
    for (const v of ticks) { const y = padT + (H - padT - padB) * (1 - v / max); svg += `<line x1="${padL}" x2="${W - 4}" y1="${y}" y2="${y}"/><text x="${padL - 6}" y="${y + 4}" text-anchor="end">${v >= 1000 ? (v / 1000) + 'k' : v}</text>`; }
    if (target) { const y = padT + (H - padT - padB) * (1 - target / max); svg += `<line class="tgt" x1="${padL}" x2="${W - 4}" y1="${y}" y2="${y}"/>`; }
    s.forEach((d, i) => {
      const x = padL + i * cw + 3, bw = cw - 6;
      const hF = (H - padT - padB) * (d.fares / max), hT = (H - padT - padB) * (d.tips / max);
      const yF = H - padB - hF, yT = yF - hT;
      if (d.fares) svg += `<rect class="b" x="${x}" y="${yF}" width="${bw}" height="${hF}" rx="2"/>`;
      if (d.tips) svg += `<rect class="t" x="${x}" y="${yT}" width="${bw}" height="${hT}" rx="2"/>`;
      if (i % 2 === 1 || i === 13) svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d.key.slice(8)}</text>`;
    });
    $('chart14').innerHTML = svg;

    const t7 = C.dailySeries(state.trips, n, 7).reduce((a, d) => a + d.gross, 0);
    const s30 = C.dailySeries(state.trips, n, 30);
    const t30 = s30.reduce((a, d) => a + d.gross, 0);
    const active = s30.filter((d) => d.count > 0).length;
    $('ins7').textContent = fmt(t7); $('ins30').textContent = fmt(t30); $('insAvg').textContent = active ? fmt(Math.round(t30 / active)) : '0';

    const bd = C.routeBreakdown(state.trips, n - 30 * 86400000, n);
    const bmax = bd.length ? bd[0].total : 1;
    $('breakdown').innerHTML = bd.length ? '' : '<div class="note">No trips in the last 30 days.</div>';
    for (const r of bd) {
      const el = document.createElement('div'); el.className = 'r';
      el.innerHTML = `<span></span><span class="num"></span><div class="bar"><i style="width:${(r.total / bmax) * 100}%"></i></div>`;
      el.children[0].textContent = r.label; el.children[1].textContent = `${r.count} × · MVR ${fmt(r.total)}`;
      $('breakdown').appendChild(el);
    }

    const hours = new Array(24).fill(0);
    for (const t of liveTrips()) if (!t.extra) hours[new Date(t.ts + C.MALDIVES_OFFSET_MS).getUTCHours()]++;
    const hmax = Math.max(1, ...hours);
    let hs = ''; const hw = (W - 16) / 24;
    hours.forEach((v, i) => { const h = 80 * (v / hmax); hs += `<rect class="b" x="${8 + i * hw + 1}" y="${90 - h}" width="${hw - 2}" height="${h}" rx="1" opacity="${v ? 1 : .15}"/>`; if (i % 6 === 0) hs += `<text x="${8 + i * hw + hw / 2}" y="110" text-anchor="middle">${String(i).padStart(2, '0')}</text>`; });
    $('chartHours').innerHTML = hs;
  }
  function niceTicks(max) {
    const step = max <= 500 ? 100 : max <= 1500 ? 250 : max <= 3000 ? 500 : 1000;
    const out = []; for (let v = step; v <= max; v += step) out.push(v); return out;
  }

  function renderSettings() {
    if (document.activeElement !== $('targetIn')) $('targetIn').value = state.settings.target;
    $('celebSw').setAttribute('aria-checked', String(!!state.settings.celebrate));
    $('hapticSw').setAttribute('aria-checked', String(!!state.settings.haptics));
    $('themeSel').value = state.settings.theme || 'system';
    $('cylSel').value = String(state.settings.cylinders || 4);
    const rl = $('routeList'); rl.innerHTML = '';
    for (const r of liveRoutes()) {
      const e = document.createElement('div'); e.className = 'entry';
      e.innerHTML = `<span class="n"></span><span class="amt num"></span><button class="del" aria-label="Edit">✎</button>`;
      e.querySelector('.n').textContent = C.routeLabel(r); e.querySelector('.amt').textContent = 'MVR ' + fmt(r.fare);
      e.querySelector('.del').addEventListener('click', () => routeSheet(r));
      rl.appendChild(e);
    }
    const cfg = S.getConfig();
    $('cloudNote').textContent = cfg ? 'Sign in with Google to back up every trip to your Supabase project and restore it on any device.' : 'Cloud sync needs a one-time Supabase setup (your own free project). Until then everything is saved on this device only.';
    $('signInBtn').disabled = !cfg;
  }

  function applyTheme() {
    const t = state.settings.theme || 'system';
    if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = dark ? '#0b1620' : '#eef4f6';
  }

  /* ---------------- sheets (no alert/confirm/prompt) ---------------- */
  function openSheet(html) { $('sheet').innerHTML = html; $('sheetOverlay').hidden = false; const f = $('sheet').querySelector('input,select,button'); if (f) setTimeout(() => f.focus(), 50); }
  function closeSheet() { $('sheetOverlay').hidden = true; $('sheet').innerHTML = ''; }
  $('sheetOverlay').addEventListener('click', (e) => { if (e.target === $('sheetOverlay')) closeSheet(); });

  function confirmSheet(title, body, onYes, yesLabel) {
    openSheet(`<h2></h2><div class="note"></div><div class="btnrow"><button class="btn" id="shNo">Cancel</button><button class="btn danger" id="shYes">${yesLabel || 'Remove'}</button></div>`);
    $('sheet').querySelector('h2').textContent = title; $('sheet').querySelector('.note').textContent = body;
    $('shNo').onclick = closeSheet; $('shYes').onclick = () => { closeSheet(); onYes(); };
  }
  function customTipSheet() {
    openSheet(`<h2>Custom tip</h2><div class="field"><label for="tipIn">Amount (MVR)</label><input id="tipIn" type="number" inputmode="decimal" min="0.5" step="0.5" placeholder="e.g. 15"></div><div class="btnrow"><button class="btn" id="shNo">Cancel</button><button class="btn primary" id="shYes">Add tip</button></div>`);
    $('shNo').onclick = closeSheet;
    const go = () => { const v = parseFloat($('tipIn').value); if (!(v > 0)) { $('tipIn').focus(); return; } closeSheet(); addTip(v); };
    $('shYes').onclick = go; $('tipIn').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }
  function routeSheet(route) {
    const isNew = !route;
    openSheet(`<h2>${isNew ? 'New route' : 'Edit route'}</h2>
      <div class="field"><label for="rFrom">From (or a single name like “Ethere”)</label><input id="rFrom" placeholder="Male'"></div>
      <div class="field"><label for="rTo">To (optional)</label><input id="rTo" placeholder="Airport"></div>
      <div class="field"><label for="rFare">Fare (MVR)</label><input id="rFare" type="number" inputmode="decimal" min="0" step="5"></div>
      <div class="btnrow"><button class="btn" id="shNo">Cancel</button>${isNew ? '' : '<button class="btn danger" id="shDel">Delete</button>'}<button class="btn primary" id="shYes">Save</button></div>`);
    if (route) { $('rFrom').value = route.from; $('rTo').value = route.to || ''; $('rFare').value = route.fare; }
    $('shNo').onclick = closeSheet;
    if (!isNew) $('shDel').onclick = () => { closeSheet(); confirmSheet('Delete route?', `${C.routeLabel(route)} will be removed from the Today screen. Past trips keep their fares.`, () => { route.deleted = true; route.updatedAt = now(); commit('routes', route.id); }, 'Delete'); };
    $('shYes').onclick = () => {
      const from = $('rFrom').value.trim(), to = $('rTo').value.trim(), fare = parseFloat($('rFare').value);
      if (!from || !(fare >= 0)) { toast('Enter a name and a fare'); return; }
      if (isNew) { const r = { id: C.uuid(), from, to, fare, updatedAt: now(), deleted: false, order: liveRoutes().length }; state.routes.push(r); commit('routes', r.id); }
      else { route.from = from; route.to = to; route.fare = fare; route.updatedAt = now(); commit('routes', route.id); }
      closeSheet(); toast('Route saved');
    };
  }
  function setupSheet() {
    const cfg = S.getConfig() || {};
    openSheet(`<h2>Supabase setup</h2>
      <div class="note">Create a free project at supabase.com, run <code>supabase/schema.sql</code>, enable the Google provider, then paste the two public values from Project Settings → API. The anon key is designed to be public; your data is protected by Row Level Security, not by hiding this key.</div>
      <div class="field"><label for="sbUrl">Project URL</label><input id="sbUrl" placeholder="https://xxxx.supabase.co" autocapitalize="off" autocorrect="off"></div>
      <div class="field"><label for="sbKey">Anon (public) key</label><input id="sbKey" placeholder="eyJhbGciOi…" autocapitalize="off" autocorrect="off"></div>
      <div class="btnrow"><button class="btn" id="shNo">Cancel</button>${cfg.url ? '<button class="btn danger" id="shClr">Remove</button>' : ''}<button class="btn primary" id="shYes">Save &amp; reload</button></div>`);
    $('sbUrl').value = cfg.url || ''; $('sbKey').value = cfg.anonKey || '';
    $('shNo').onclick = closeSheet;
    if (cfg.url) $('shClr').onclick = () => { S.setConfig(null); S.resetMeta(); location.reload(); };
    $('shYes').onclick = () => {
      const url = $('sbUrl').value.trim().replace(/\/$/, ''), anonKey = $('sbKey').value.trim();
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(url) && !/^https:\/\//.test(url)) { toast('URL should look like https://xxxx.supabase.co'); return; }
      if (anonKey.length < 20) { toast('That key looks too short'); return; }
      S.setConfig({ url, anonKey }); location.reload();
    };
  }
  function ownerConflictSheet(uid, done) {
    openSheet(`<h2>Data from another account</h2>
      <div class="note">This device already holds trips saved under a different Google account. What should happen to them?</div>
      <div class="btnrow" style="flex-direction:column">
        <button class="btn primary" id="shMerge">Keep them and add to my account</button>
        <button class="btn danger" id="shDiscard">Discard them and load my cloud data</button>
      </div>`);
    $('shMerge').onclick = () => { closeSheet(); done('merge'); };
    $('shDiscard').onclick = () => { closeSheet(); done('discard'); };
  }

  let toastTimer;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600); }

  /* ---------------- import / export ---------------- */
  function exportJSON() {
    const json = JSON.stringify(C.makeBackup(state, now()), null, 2);
    const name = `trip-earnings-pro-backup-${C.dayKey(now())}.json`;
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('Backup downloaded (if downloads are blocked here, use Copy)');
    } catch (e) { toast('Download blocked — use “Copy backup to clipboard”'); }
  }
  async function copyJSON() {
    const json = JSON.stringify(C.makeBackup(state, now()));
    try { await navigator.clipboard.writeText(json); toast('Backup copied'); }
    catch (e) { openSheet(`<h2>Backup JSON</h2><div class="note">Select all and copy:</div><textarea id="bk" style="width:100%;height:200px;font:12px monospace;background:var(--panel-2);color:var(--fg);border:1px solid var(--line);border-radius:10px"></textarea><button class="btn block" id="shNo">Close</button>`); $('bk').value = json; $('bk').select(); $('shNo').onclick = closeSheet; }
  }
  function importJSON(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const b = C.parseBackup(String(rd.result));
        const beforeT = liveTrips().length;
        state.trips = C.mergeById(state.trips, b.trips);
        // Legacy (v2) backups have no updatedAt: keep this device's routes and only add unknown ones.
        const have = new Set(state.routes.map((r) => r.id));
        const incoming = b.version >= 3 ? b.routes : b.routes.filter((r) => !have.has(r.id)).map((r) => ({ ...r, updatedAt: now() }));
        state.routes = C.mergeById(state.routes, incoming);
        if (b.settings && b.settings.target) state.settings.target = Number(b.settings.target);
        if (b.version >= 3 && b.celebrated) state.celebrated = { ...state.celebrated, ...b.celebrated };
        save();
        for (const t of b.trips) S.markDirty('trips', t.id);
        for (const r of incoming) S.markDirty('routes', r.id);
        S.markDirty('profile');
        render();
        toast(`Imported ${b.trips.length} records (${liveTrips().length - beforeT} new)`);
      } catch (e) { toast('Import failed: ' + e.message); }
    };
    rd.readAsText(file);
  }

  /* ---------------- GPS + wake lock ---------------- */
  let geoWatch = null, wakeLock = null;
  async function setDrive(on) {
    $('driveSw').setAttribute('aria-checked', String(on));
    if (on) {
      if (!navigator.geolocation) { toast('GPS not available in this browser'); return setDrive(false); }
      geoWatch = navigator.geolocation.watchPosition((pos) => {
        const mps = pos.coords.speed;
        const kmh = mps == null || Number.isNaN(mps) ? null : mps * 3.6;
        $('speedVal').textContent = kmh == null ? '—' : String(Math.round(kmh));
        $('speedAcc').textContent = kmh == null ? 'no speed fix yet' : `±${Math.round(pos.coords.accuracy)} m`;
        $('speedo').classList.toggle('hot', kmh != null && kmh >= C.SPEED_WARN_KMH);
        onSpeed(kmh);
      }, (err) => { toast('GPS: ' + err.message); setDrive(false); }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
      try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
      $('speedAcc').textContent = 'waiting for GPS…';
    } else {
      if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch); geoWatch = null;
      if (wakeLock) { try { await wakeLock.release(); } catch (e) {} wakeLock = null; }
      $('speedVal').textContent = '—'; $('speedAcc').textContent = 'GPS off'; $('speedo').classList.remove('hot');
      speedState = { armed: true };
    }
  }

  /* ---------------- acoustic RPM (honest: dash unless clearly periodic) ---------------- */
  let audioCtx = null, mic = null, rpmRaf = null;
  async function setRpm(on) {
    $('rpmSw').setAttribute('aria-checked', String(on));
    if (on) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Microphone not available here'); return setRpm(false); }
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioCtx.createMediaStreamSource(mic);
        const lp = audioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
        const an = audioCtx.createAnalyser(); an.fftSize = 8192;
        src.connect(lp); lp.connect(an);
        const buf = new Float32Array(an.fftSize);
        const sr = audioCtx.sampleRate;
        let smooth = null;
        const tick = () => {
          an.getFloatTimeDomainData(buf);
          const res = detectPeriod(buf, sr, 15, 220); // engine firing band 15–220 Hz
          if (res && res.conf > 0.6 && res.rms > 0.01) {
            const rpm = C.rpmFromFiringHz(res.hz, state.settings.cylinders || 4);
            smooth = smooth == null ? rpm : Math.round(smooth * 0.8 + rpm * 0.2);
            $('rpmVal').textContent = String(Math.round(smooth / 10) * 10);
            $('rpmConf').textContent = `${Math.round(res.conf * 100)}% periodic`; $('rpmConf').className = 'pill ok';
          } else {
            smooth = null; $('rpmVal').textContent = '—';
            $('rpmConf').textContent = res && res.rms <= 0.01 ? 'too quiet' : 'no clear engine tone'; $('rpmConf').className = 'pill';
          }
          rpmRaf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) { toast('Microphone: ' + e.message); setRpm(false); }
    } else {
      if (rpmRaf) cancelAnimationFrame(rpmRaf); rpmRaf = null;
      if (mic) mic.getTracks().forEach((t) => t.stop()); mic = null;
      if (audioCtx) { try { await audioCtx.close(); } catch (e) {} audioCtx = null; }
      $('rpmVal').textContent = '—'; $('rpmConf').textContent = 'mic off'; $('rpmConf').className = 'pill';
    }
  }
  /* Normalised autocorrelation; returns the strongest lag in [minHz,maxHz]. */
  function detectPeriod(buf, sr, minHz, maxHz) {
    const n = buf.length; let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < 1e-4) return { hz: 0, conf: 0, rms };
    const minLag = Math.floor(sr / maxHz), maxLag = Math.min(Math.floor(sr / minHz), n >> 1);
    let e0 = 0; for (let i = 0; i < n - maxLag; i++) e0 += buf[i] * buf[i];
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0, e1 = 0;
      for (let i = 0; i < n - maxLag; i++) { s += buf[i] * buf[i + lag]; e1 += buf[i + lag] * buf[i + lag]; }
      const c = s / Math.sqrt(e0 * e1 + 1e-12);
      if (c > best) { best = c; bestLag = lag; }
    }
    return { hz: bestLag ? sr / bestLag : 0, conf: best, rms };
  }

  /* ---------------- sync status UI ---------------- */
  const statusText = {
    unconfigured: 'Local only', signedout: 'Not signed in', offline: 'Offline', online: 'Online',
    syncing: 'Syncing…', synced: 'Synced', error: 'Sync failed', conflict: 'Needs attention',
  };
  S.onChange(({ status, detail, user, pending }) => {
    const b = $('syncBadge'); b.dataset.s = status === 'conflict' ? 'error' : status;
    $('syncText').textContent = statusText[status] || status;
    b.title = detail || '';
    $('acctSignedOut').hidden = !!user; $('acctSignedIn').hidden = !user;
    if (user) {
      const md = user.user_metadata || {};
      $('acctName').textContent = md.full_name || md.name || 'Signed in';
      $('acctEmail').textContent = user.email || '';
      if (md.avatar_url) { $('acctImg').src = md.avatar_url; $('acctImg').hidden = false; }
    }
    $('pendingCount').textContent = pending;
    const ls = S.lastSync(); $('lastSync').textContent = ls ? new Date(ls).toLocaleString('en-GB', { timeZone: 'Indian/Maldives' }) : 'never';
  });
  $('syncBadge').addEventListener('click', () => { const { status, detail } = S.getStatus(); if (status === 'unconfigured' || status === 'signedout') { showView('settings'); } else { toast(detail || statusText[status]); if (status !== 'offline') S.sync().catch(() => {}); } });

  /* ---------------- wire up ---------------- */
  function showView(v) {
    document.querySelectorAll('.view').forEach((s) => { s.hidden = s.id !== 'view-' + v; });
    document.querySelectorAll('nav button').forEach((b) => { if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('undoBtn').addEventListener('click', undo);
  $('editRoutesBtn').addEventListener('click', () => showView('settings'));
  $('addRouteBtn').addEventListener('click', () => routeSheet(null));
  $('targetIn').addEventListener('change', () => { const v = parseFloat($('targetIn').value); if (v > 0) { state.settings.target = v; commitProfile(); checkAchievements(); } });
  $('celebSw').addEventListener('click', () => { state.settings.celebrate = !state.settings.celebrate; commitProfile(); });
  $('hapticSw').addEventListener('click', () => { state.settings.haptics = !state.settings.haptics; commitProfile(); });
  $('themeSel').addEventListener('change', () => { state.settings.theme = $('themeSel').value; commitProfile(); });
  $('cylSel').addEventListener('change', () => { state.settings.cylinders = Number($('cylSel').value); commitProfile(); });
  $('driveSw').addEventListener('click', () => setDrive($('driveSw').getAttribute('aria-checked') !== 'true'));
  $('rpmSw').addEventListener('click', () => setRpm($('rpmSw').getAttribute('aria-checked') !== 'true'));
  $('exportBtn').addEventListener('click', exportJSON);
  $('copyBtn').addEventListener('click', copyJSON);
  $('importIn').addEventListener('change', (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });
  $('wipeBtn').addEventListener('click', () => confirmSheet('Delete everything on this device?', 'Trips, routes and settings stored in this browser will be erased. Cloud copies (if signed in) are not touched.', () => { localStorage.removeItem(STATE_KEY); S.resetMeta(); state = defaults(); save(); render(); toast('Device data deleted'); }, 'Delete'));
  $('setupBtn').addEventListener('click', setupSheet);
  $('signInBtn').addEventListener('click', () => S.signIn().catch((e) => toast(e.message)));
  $('signOutBtn').addEventListener('click', () => confirmSheet('Sign out?', 'Your trips stay on this device. Unsynced changes will upload the next time you sign in.', () => S.signOut(), 'Sign out'));
  $('syncNowBtn').addEventListener('click', () => S.sync().catch((e) => toast(e.message)));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  // Midnight rollover (Maldives time): re-render exactly at 00:00 MVT and re-check every minute.
  function armMidnight() { setTimeout(() => { render(); toast('New day — counters reset, history kept'); armMidnight(); }, C.nextMidnight(now()) - now() + 500); }
  armMidnight();
  let lastKey = C.dayKey(now());
  setInterval(() => { const k = C.dayKey(now()); if (k !== lastKey) { lastKey = k; render(); } }, 60000);

  // PWA install (optional)
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; $('installBtn').hidden = false; $('installNote').hidden = true; });
  $('installBtn').addEventListener('click', async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('installBtn').hidden = true; });
  if ('serviceWorker' in navigator && location.protocol === 'https:') { navigator.serviceWorker.register('sw.js').catch(() => { /* not available on this host; app still works */ }); }

  // Sync store adapter
  S.init({
    getState: () => state,
    hasLocalData: () => liveTrips().length > 0,
    replaceAll: ({ trips, routes }) => { state.trips = trips; state.routes = routes.length ? routes : defaults().routes; save(); render(); },
    onOwnerConflict: ownerConflictSheet,
    applyRemote: (trips, routes, profile) => {
      if (trips.length) state.trips = C.mergeById(state.trips, trips);
      if (routes.length) state.routes = C.mergeById(state.routes, routes);
      if (profile && Number(profile.updated_at) > (state.profileUpdatedAt || 0)) {
        state.settings = { ...state.settings, ...(profile.settings || {}) };
        state.celebrated = { ...state.celebrated, ...(profile.celebrated || {}) };
        state.profileUpdatedAt = Number(profile.updated_at);
      }
      save(); render();
    },
  });

  render();
})();
