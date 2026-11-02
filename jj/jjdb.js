// JJDB — the shared data layer for the JJ suite on GitHub Pages.
// Same shape as the old Claude artifact database (collection/doc, onSnapshot, add/set/update/delete),
// backed by Supabase. Every row belongs to the signed-in user; the database refuses everyone else.
(function () {
  const URL = 'https://infwpvjqxekkvwzuhhuk.supabase.co';
  const KEY = 'sb_publishable_f1KhdutVVK95LeyFxv576A_E9d_HuR4';
  let sb = null;
  function client() {
    if (!sb) sb = window.supabase.createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'jj-auth' } });
    return sb;
  }

  // ── Sign-in screen (shown once per device) ──
  function loginScreen() {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.id = 'jjLogin';
      wrap.innerHTML = `
        <style>
          #jjLogin{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:#0f0e0c;color:#f0ede6;font:15px/1.45 Inter,system-ui,-apple-system,sans-serif;padding:16px}
          #jjLogin form{width:100%;max-width:340px;display:flex;flex-direction:column;gap:10px}
          #jjLogin h1{margin:0 0 6px;font-size:22px;font-weight:800;letter-spacing:-.02em}
          #jjLogin h1 span{color:#e07040}
          #jjLogin input{height:46px;border-radius:11px;border:1px solid #2e2b24;background:#1f1d17;color:#f0ede6;padding:0 12px;font:inherit;font-size:16px}
          #jjLogin button{height:46px;border-radius:11px;border:0;background:#e07040;color:#fff;font:inherit;font-weight:700;font-size:16px;cursor:pointer}
          #jjLogin button.sec{background:none;color:#a09890;font-weight:600;font-size:14px;height:auto;padding:6px}
          #jjLogin .msg{font-size:13.5px;color:#a09890;min-height:20px}
          #jjLogin .msg.err{color:#e05a48}
        </style>
        <form>
          <h1><span>JJ</span> sign in</h1>
          <input name="email" type="email" autocomplete="email" placeholder="Email" required>
          <input name="pw" type="password" autocomplete="current-password" placeholder="Password" required minlength="8">
          <button type="submit">Sign in</button>
          <button type="button" class="sec" data-new>First time? Create my account</button>
          <div class="msg"></div>
        </form>`;
      document.body.appendChild(wrap);
      const f = wrap.querySelector('form'), msg = wrap.querySelector('.msg');
      const say = (t, err) => { msg.textContent = t; msg.classList.toggle('err', !!err); };
      f.onsubmit = async e => {
        e.preventDefault(); say('Signing in…');
        const { data, error } = await client().auth.signInWithPassword({ email: f.email.value.trim(), password: f.pw.value });
        if (error) return say(error.message === 'Email not confirmed' ? 'Check your email and tap the confirm link first, then sign in here.' : 'That didn’t work: ' + error.message, true);
        wrap.remove(); resolve(data.session);
      };
      wrap.querySelector('[data-new]').onclick = async () => {
        if (!f.email.value || f.pw.value.length < 8) return say('Type your email and a password (8+ characters) first.', true);
        say('Creating your account…');
        const { data, error } = await client().auth.signUp({ email: f.email.value.trim(), password: f.pw.value, options: { emailRedirectTo: location.href.split('#')[0] } });
        if (error) return say(error.message, true);
        if (data.session) { wrap.remove(); resolve(data.session); }
        else say('Account made. Check your email, tap the confirm link, then come back and sign in.');
      };
    });
  }

  // ── Document store with live updates ──
  async function use(app) {
    const c = client();
    let { data: { session } } = await c.auth.getSession();
    if (!session) session = await loginScreen();

    const cache = new Map();            // collection -> Map(id -> data)
    const colListeners = new Map();     // collection -> Set(fn)
    const docListeners = new Map();     // "col/id" -> Set(fn)
    const col = name => { if (!cache.has(name)) cache.set(name, new Map()); return cache.get(name); };

    // Load everything for this app once.
    for (let from = 0; ; from += 1000) {
      const { data, error } = await c.from('docs').select('collection,id,data').eq('app', app).range(from, from + 999);
      if (error) throw error;
      data.forEach(r => col(r.collection).set(r.id, r.data));
      if (data.length < 1000) break;
    }

    const snapCol = name => ({ docs: [...col(name)].map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)) })) });
    const snapDoc = (name, id) => { const d = col(name).get(id); return { id, exists: d !== undefined, data: () => d === undefined ? undefined : JSON.parse(JSON.stringify(d)) }; };
    function notify(name, id) {
      (colListeners.get(name) || []).forEach(fn => fn(snapCol(name)));
      (docListeners.get(name + '/' + id) || []).forEach(fn => fn(snapDoc(name, id)));
    }
    function local(name, id, d) { if (d === null) col(name).delete(id); else col(name).set(id, d); notify(name, id); }

    // Live updates from other devices and from Claude.
    c.channel('docs-' + app)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'app=eq.' + app }, p => {
        const r = p.new && p.new.id ? p.new : p.old;
        if (!r || !r.collection) return;
        local(r.collection, r.id, p.eventType === 'DELETE' ? null : p.new.data);
      })
      .subscribe();

    async function write(name, id, d) {
      const prev = col(name).get(id);
      local(name, id, d);
      const { error } = await c.from('docs').upsert({ app, collection: name, id, data: d, updated_at: new Date().toISOString() }, { onConflict: 'owner,app,collection,id' });
      if (error) { local(name, id, prev === undefined ? null : prev); throw error; }
    }
    async function remove(name, id) {
      const prev = col(name).get(id);
      local(name, id, null);
      const { error } = await c.from('docs').delete().eq('app', app).eq('collection', name).eq('id', id);
      if (error) { if (prev !== undefined) local(name, id, prev); throw error; }
    }
    const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const clone = o => JSON.parse(JSON.stringify(o));

    function docRef(path) {
      const i = path.lastIndexOf('/'), name = path.slice(0, i), id = path.slice(i + 1);
      return {
        id,
        get: async () => snapDoc(name, id),
        set: d => write(name, id, clone(d)),
        update: patch => write(name, id, Object.assign({}, col(name).get(id) || {}, clone(patch))),
        delete: () => remove(name, id),
        onSnapshot(fn) { const k = name + '/' + id; if (!docListeners.has(k)) docListeners.set(k, new Set()); docListeners.get(k).add(fn); fn(snapDoc(name, id)); return () => docListeners.get(k).delete(fn); }
      };
    }
    return {
      doc: docRef,
      collection: name => ({
        add: async d => { const id = newId(); await write(name, id, clone(d)); return { id }; },
        doc: id => docRef(name + '/' + id),
        onSnapshot(fn) { if (!colListeners.has(name)) colListeners.set(name, new Set()); colListeners.get(name).add(fn); fn(snapCol(name)); return () => colListeners.get(name).delete(fn); }
      }),
      signOut: () => c.auth.signOut().then(() => location.reload())
    };
  }

  window.JJDB = { use };
})();
