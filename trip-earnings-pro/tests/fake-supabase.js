/* In-memory stand-in for supabase-js used ONLY by tests/sync.e2e.py.
   It mimics the small subset the app uses: auth session events, from().upsert/select/gt/eq/maybeSingle.
   Rows are filtered by user_id to imitate RLS. Shared across "devices" through window.__cloud (injected). */
(function () {
  const cloud = window.__cloud || (window.__cloud = { trips: [], routes: [], profiles: [], calls: [] });
  function createClient(url, key) {
    const authListeners = [];
    let session = window.__session || null;
    const auth = {
      onAuthStateChange(fn) { authListeners.push(fn); return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session } }; },
      async signInWithOAuth(opts) { window.__oauthCalled = opts; return { data: {}, error: null }; },
      async signOut() { session = null; authListeners.forEach((f) => f('SIGNED_OUT', null)); return { error: null }; },
      _setSession(s) { session = s; authListeners.forEach((f) => f('SIGNED_IN', s)); },
    };
    const uid = () => session && session.user.id;
    function from(table) {
      const rows = cloud[table];
      const q = { _filters: [], _single: false };
      q.upsert = async (data, { onConflict }) => {
        cloud.calls.push(['upsert', table, data.length || 1]);
        if (window.__cloudDown) return { error: { message: 'network down' } };
        for (const r of [].concat(data)) {
          if (r.user_id !== uid()) return { error: { message: 'RLS: new row violates row-level security policy' } };
          const i = rows.findIndex((x) => x[onConflict] === r[onConflict]);
          if (i >= 0) rows[i] = r; else rows.push(r);
        }
        return { error: null };
      };
      q.select = () => q;
      q.gt = (col, v) => { q._filters.push((r) => r[col] > v); return q; };
      q.eq = (col, v) => { q._filters.push((r) => r[col] === v); return q; };
      q.maybeSingle = () => { q._single = true; return q; };
      q.then = (res, rej) => {
        cloud.calls.push(['select', table]);
        if (window.__cloudDown) return Promise.resolve({ data: null, error: { message: 'network down' } }).then(res, rej);
        let out = rows.filter((r) => r.user_id === uid()); // RLS
        for (const f of q._filters) out = out.filter(f);
        return Promise.resolve({ data: q._single ? (out[0] || null) : out, error: null }).then(res, rej);
      };
      return q;
    }
    const c = { auth, from };
    window.__sb = c;
    return c;
  }
  window.supabase = { createClient };
})();
