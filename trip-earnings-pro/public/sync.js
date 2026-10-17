/* Trip Earnings Pro — Supabase auth + sync layer.
   Real Google OAuth through Supabase Auth; offline queue; last-write-wins merge.
   Only the public anon key is ever used here. Row Level Security on the server
   is what isolates users — see supabase/schema.sql. */
(function (root) {
  'use strict';
  const C = root.TECore;
  const CFG_KEY = 'tep.supabase';
  const META_KEY = 'tep.syncmeta';
  const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';

  const listeners = new Set();
  let client = null, user = null, status = 'offline', detail = '', timer = null, pulling = false, pushing = false;

  function loadJSON(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function saveJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }

  function getConfig() { return loadJSON(CFG_KEY, null); }
  function setConfig(cfg) { if (cfg) saveJSON(CFG_KEY, cfg); else localStorage.removeItem(CFG_KEY); }
  function meta() { return loadJSON(META_KEY, { lastPull: 0, lastSync: 0, dirty: { trips: [], routes: [], profile: false }, owner: null }); }
  function setMeta(m) { saveJSON(META_KEY, m); }

  function emit() { for (const fn of listeners) fn({ status, detail, user, pending: pendingCount() }); }
  function setStatus(s, d) { status = s; detail = d || ''; emit(); }
  function onChange(fn) { listeners.add(fn); fn({ status, detail, user, pending: pendingCount() }); return () => listeners.delete(fn); }

  function pendingCount() { const m = meta(); return m.dirty.trips.length + m.dirty.routes.length + (m.dirty.profile ? 1 : 0); }

  /* Mark local records dirty. Called by the app on every change. */
  function markDirty(table, id) {
    const m = meta();
    if (table === 'profile') m.dirty.profile = true;
    else if (!m.dirty[table].includes(id)) m.dirty[table].push(id);
    setMeta(m);
    emit();
    scheduleSync(800);
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (root.supabase) return res();
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load supabase-js (offline or blocked)'));
      document.head.appendChild(s);
    });
  }

  let store = null; // set by init: { getState(), applyRemote(trips, routes, profile) }

  async function init(st) {
    store = st;
    const cfg = getConfig();
    if (!cfg || !cfg.url || !cfg.anonKey) { setStatus('unconfigured', 'Supabase not configured'); return; }
    if (!navigator.onLine) { setStatus('offline', 'Offline'); }
    try {
      await loadScript(SUPABASE_JS);
    } catch (e) { setStatus(navigator.onLine ? 'error' : 'offline', e.message); return; }
    try {
      client = root.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    } catch (e) { setStatus('error', 'Bad Supabase URL or key'); return; }

    client.auth.onAuthStateChange((_evt, session) => {
      user = session ? session.user : null;
      if (user) handleOwner(user.id); else setStatus(navigator.onLine ? 'signedout' : 'offline', 'Not signed in');
    });
    const { data } = await client.auth.getSession();
    user = data && data.session ? data.session.user : null;
    if (user) handleOwner(user.id); else setStatus(navigator.onLine ? 'signedout' : 'offline', 'Not signed in');

    root.addEventListener('online', () => { setStatus(user ? 'online' : 'signedout', 'Back online'); scheduleSync(300); });
    root.addEventListener('offline', () => setStatus('offline', 'Offline'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(500); });
    setInterval(() => scheduleSync(0), 60000);
  }

  /* A device may hold local data from a different account. Let the app decide. */
  function handleOwner(uid) {
    const m = meta();
    if (m.owner && m.owner !== uid && store.hasLocalData()) {
      setStatus('conflict', 'Device holds data from another account');
      store.onOwnerConflict(uid, (choice) => {
        const mm = meta();
        if (choice === 'discard') { store.replaceAll({ trips: [], routes: [] }); mm.dirty = { trips: [], routes: [], profile: false }; }
        else { mm.dirty.trips = store.getState().trips.map((t) => t.id); mm.dirty.routes = store.getState().routes.map((r) => r.id); mm.dirty.profile = true; }
        mm.owner = uid; mm.lastPull = 0; setMeta(mm);
        setStatus('online', 'Signed in'); scheduleSync(0);
      });
      return;
    }
    if (!m.owner) {
      // First sign-in on this device: everything local belongs to this user and must go up.
      m.owner = uid; m.lastPull = 0;
      m.dirty.trips = store.getState().trips.map((t) => t.id);
      m.dirty.routes = store.getState().routes.map((r) => r.id);
      m.dirty.profile = true;
      setMeta(m);
    }
    setStatus(navigator.onLine ? 'online' : 'offline', 'Signed in');
    scheduleSync(0);
  }

  function scheduleSync(ms) { clearTimeout(timer); timer = setTimeout(() => sync().catch(() => {}), ms); }

  const toRow = {
    trips: (t, uid) => ({ id: t.id, user_id: uid, ts: t.ts, from_loc: t.from, to_loc: t.to, fare: t.fare, extra: t.extra, pay: t.pay, note: t.note, route_id: t.routeId, updated_at: t.updatedAt, deleted: !!t.deleted }),
    routes: (r, uid) => ({ id: r.id, user_id: uid, from_loc: r.from, to_loc: r.to, fare: r.fare, updated_at: r.updatedAt, deleted: !!r.deleted }),
  };
  const fromRow = {
    trips: (r) => ({ id: r.id, ts: Number(r.ts), from: r.from_loc, to: r.to_loc || '', fare: Number(r.fare), extra: !!r.extra, pay: r.pay || 'cash', note: r.note || '', routeId: r.route_id, updatedAt: Number(r.updated_at), deleted: !!r.deleted }),
    routes: (r) => ({ id: r.id, from: r.from_loc, to: r.to_loc || '', fare: Number(r.fare), updatedAt: Number(r.updated_at), deleted: !!r.deleted }),
  };

  async function sync() {
    if (!client || !user || !navigator.onLine || pushing || pulling) return;
    pushing = true;
    setStatus('syncing', 'Syncing…');
    try {
      // PULL first, so a stale local copy never overwrites a newer remote row.
      pulling = true;
      const since = meta().lastPull;
      const pullStart = Date.now();
      const [tr, ro, pr] = await Promise.all([
        client.from('trips').select('*').gt('updated_at', since),
        client.from('routes').select('*').gt('updated_at', since),
        client.from('profiles').select('*').eq('user_id', user.id).maybeSingle(),
      ]);
      if (tr.error) throw tr.error; if (ro.error) throw ro.error; if (pr.error) throw pr.error;
      store.applyRemote(tr.data.map(fromRow.trips), ro.data.map(fromRow.routes), pr.data || null);
      pulling = false;
      // PUSH dirty records (after merge, so what goes up is the winning version).
      const m = meta();
      const st = store.getState();
      for (const table of ['trips', 'routes']) {
        const ids = new Set(m.dirty[table]);
        if (!ids.size) continue;
        const rows = st[table].filter((r) => ids.has(r.id)).map((r) => toRow[table](r, user.id));
        if (rows.length) {
          const { error } = await client.from(table).upsert(rows, { onConflict: table === 'routes' ? 'user_id,id' : 'id' });
          if (error) throw error;
        }
        const mm = meta(); mm.dirty[table] = mm.dirty[table].filter((id) => !ids.has(id)); setMeta(mm);
      }
      if (m.dirty.profile) {
        const { error } = await client.from('profiles').upsert({ user_id: user.id, settings: st.settings, celebrated: st.celebrated, updated_at: st.profileUpdatedAt || Date.now() }, { onConflict: 'user_id' });
        if (error) throw error;
        const mm = meta(); mm.dirty.profile = false; setMeta(mm);
      }
      { const mm = meta(); mm.lastPull = pullStart - 5000; mm.lastSync = Date.now(); setMeta(mm); }
      setStatus('synced', 'Synced');
    } catch (e) {
      setStatus(navigator.onLine ? 'error' : 'offline', (e && e.message) || 'Sync failed');
      throw e;
    } finally { pushing = false; pulling = false; }
  }

  async function signIn() {
    if (!client) throw new Error('Configure Supabase first');
    const redirectTo = location.origin + location.pathname;
    const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
    if (error) throw error;
  }
  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
    user = null;
    setStatus('signedout', 'Signed out');
  }

  function lastSync() { return meta().lastSync; }
  function resetMeta() { localStorage.removeItem(META_KEY); }

  root.TESync = { init, onChange, markDirty, sync: () => sync(), signIn, signOut, getConfig, setConfig, lastSync, pendingCount, resetMeta, getUser: () => user, getStatus: () => ({ status, detail }) };
})(typeof self !== 'undefined' ? self : this);
