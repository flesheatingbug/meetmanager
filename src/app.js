/* XC Meet Manager — UI */
(function () {
  'use strict';
  const X = window.XC;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const SEED = JSON.parse($('#seed-data').textContent);
  const LS_CUR = 'xcmm.current.v1', LS_REF = 'xcmm.reference.v1', LS_LAST = 'xcmm.lastMeet', LS_BACKUP = 'xcmm.lastBackup';
  const APP_VERSION = '1.3.0';
  let uidc = Date.now();
  const uid = () => 'a' + (uidc++).toString(36);

  // ================================================================ state
  let S = null, dirty = false;
  const ui = { tab: 'meets', q: '', fCat: '', fTeam: '', onlyProblems: false, sel: new Set(), evt: null, listTab: 'booklet', setupTab: 'cats', clubQ: '', sort: 'id', meetQ: '' };
  let summaries = []; // [{id,title,date,venue,races,athletes,finishers,updatedAt}]

  function referenceData() {
    try { const r = JSON.parse(localStorage.getItem(LS_REF)); if (r && r.ageCategories) return r; } catch (e) { /* ignore */ }
    return clone(SEED);
  }
  function blankState() {
    const ref = referenceData();
    const y = new Date().getFullYear();
    return {
      format: 'xc-meet-manager', version: 1, id: newMeetId(),
      settings: { title: 'New cross country meet', venue: '', date: '', time: '', year: y, startId: 1, autoNumber: true, regionLevel: 'Provincial', region: '', checkInExtraRows: 5, unknownTakesPosition: true, upperSurname: true },
      ageCategories: ref.ageCategories, mastersTeamCategories: ref.mastersTeamCategories, teams: ref.teams,
      counties: ref.counties, provinces: ref.provinces, aliases: ref.aliases || {},
      program: [], entries: [], results: {},
    };
  }
  function newMeetId() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function migrate(d) {
    const b = blankState();
    const s = Object.assign(b, d);
    s.id = d.id || b.id;
    s.settings = Object.assign(blankState().settings, d.settings || {});
    s.aliases = s.aliases || {};
    s.results = s.results || {};
    s.entries = (s.entries || []).map(e => {
      const o = { uid: e.uid || uid(), id: e.id === '' || e.id == null ? null : +e.id, name: e.name || '', category: e.category || '', gender: e.gender || '', dob: e.dob || '', reg: e.reg || '', team: e.team || '', scoringTeam: e.scoringTeam || '', county: e.county || '', province: e.province || '', mastersTeam: e.mastersTeam || '', mastersCountyTeam: e.mastersCountyTeam || '' };
      if (o.scoringTeam === o.team) o.scoringTeam = '';
      return o;
    });
    for (const k of Object.keys(s.results)) s.results[k] = s.results[k].map(r => ({ id: r.id == null ? '' : String(r.id), time: r.time || '' }));
    s.program.forEach(p => { p.categories = p.categories || []; p.type = p.type || 'CC'; });
    delete s.app; delete s.appVersion; delete s.savedAt;
    return s;
  }
  const scoringState = () => ({ ...S, entries: S.entries.map(e => ({ ...e, scoringTeam: e.scoringTeam || e.team })) });

  // derived caches
  let cache = null;
  function derive() {
    if (cache) return cache;
    const catNames = S.ageCategories.map(c => c.name);
    const progCats = new Set(S.program.flatMap(p => p.categories));
    cache = {
      catByName: new Map(S.ageCategories.map(c => [c.name, c])),
      teamByName: new Map(S.teams.map(t => [t.name, t])),
      progCats,
      catOrder: [...S.program.flatMap(p => p.categories), ...catNames.filter(c => !progCats.has(c))],
      clubMatch: X.makeClubMatcher(S.teams, S.aliases),
      catMatch: X.makeCategoryMatcher(S.ageCategories, progCats),
      issues: X.validate({ ...S, entries: S.entries }),
      eventOfCat: new Map(S.program.flatMap(p => p.categories.map(c => [c, p]))),
    };
    cache.issuesByUid = new Map();
    for (const i of cache.issues) { if (!cache.issuesByUid.has(i.uid)) cache.issuesByUid.set(i.uid, []); cache.issuesByUid.get(i.uid).push(i); }
    return cache;
  }

  // ================================================================ meets library (IndexedDB)
  const newRev = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const DB = {
    db: null,
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open('xc-meet-manager', 2);
        r.onupgradeneeded = () => {
          const db = r.result;
          for (const n of ['meets', 'summaries', 'sync']) if (!db.objectStoreNames.contains(n)) db.createObjectStore(n);
        };
        r.onsuccess = () => { DB.db = r.result; res(); };
        r.onerror = () => rej(r.error);
      });
    },
    tx(stores, mode, fn) {
      return new Promise((res, rej) => {
        const t = DB.db.transaction(stores, mode); let out;
        Promise.resolve(fn(t)).then(v => { out = v; });
        t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    },
    req: r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
    /** Save a meet. opts.syncRev = it came from the sync folder (so it's already in sync). */
    put(state, opts = {}) {
      const sum = summarise(state);
      return DB.tx(['meets', 'summaries', 'sync'], 'readwrite', t => {
        t.objectStore('meets').put(state, state.id); t.objectStore('summaries').put(sum, state.id);
        const ms = t.objectStore('sync'); const g = ms.get(state.id);
        g.onsuccess = () => {
          const old = g.result || {};
          ms.put(opts.syncRev ? { id: state.id, rev: opts.syncRev, baseRev: opts.syncRev, dirty: false, at: opts.at || '', history: opts.history || [] }
            : opts.copyRev ? { id: state.id, rev: opts.copyRev, baseRev: null, dirty: true, at: opts.at || '', history: [] }
            : { id: state.id, rev: newRev(), baseRev: old.baseRev || null, dirty: true, at: new Date().toISOString(), history: old.history || [] }, state.id);
        };
      }).then(() => sum);
    },
    get(id) { return DB.tx(['meets'], 'readonly', t => DB.req(t.objectStore('meets').get(id))); },
    list() { return DB.tx(['summaries'], 'readonly', t => DB.req(t.objectStore('summaries').getAll())); },
    /** Delete a meet, leaving a tombstone so other computers delete it too. */
    del(id, opts = {}) {
      return DB.tx(['meets', 'summaries', 'sync'], 'readwrite', t => {
        t.objectStore('meets').delete(id); t.objectStore('summaries').delete(id);
        const ms = t.objectStore('sync'); const g = ms.get(id);
        g.onsuccess = () => {
          const old = g.result || {};
          ms.put(opts.syncRev ? { id, deleted: true, rev: opts.syncRev, baseRev: opts.syncRev, dirty: false, at: opts.at || '', history: opts.history || [] }
            : { id, deleted: true, rev: newRev(), baseRev: old.baseRev || null, dirty: !!old.baseRev, at: new Date().toISOString(), history: old.history || [] }, id);
        };
      });
    },
    all() { return DB.tx(['meets'], 'readonly', t => DB.req(t.objectStore('meets').getAll())); },
    getMeta(id) { return DB.tx(['sync'], 'readonly', t => DB.req(t.objectStore('sync').get(id))); },
    putMeta(m) { return DB.tx(['sync'], 'readwrite', t => { t.objectStore('sync').put(m, m.id); }); },
    allMeta() { return DB.tx(['sync'], 'readonly', t => DB.req(t.objectStore('sync').getAll())); },
  };
  function summarise(st) {
    return {
      id: st.id, title: st.settings.title, date: st.settings.date, venue: st.settings.venue,
      races: st.program.length, athletes: st.entries.length,
      finishers: Object.values(st.results || {}).reduce((a, r) => a + r.length, 0),
      updatedAt: new Date().toISOString(), conflictOf: st.conflictOf || '',
    };
  }
  async function refreshSummaries() { summaries = await DB.list(); summaries.sort(meetSort); }
  const meetSort = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.updatedAt || '').localeCompare(a.updatedAt || '');

  let saveTimer = null, saving = null;
  async function flushSave() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!S || !dirty) return;
    const snapshot = S;
    try {
      saving = DB.put(JSON.parse(JSON.stringify(snapshot)));
      const sum = await saving;
      summaries = summaries.filter(x => x.id !== sum.id).concat(sum).sort(meetSort);
      if (snapshot === S) { dirty = false; renderChrome(); }
      syncSoon();
    } catch (e) { toast('Could not save: ' + e.message, true); }
    finally { saving = null; }
  }
  function commit(opts = {}) {
    cache = null; dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 400);
    if (opts.render !== false) render(); else renderChrome();
  }
  async function openMeet(id, tab) {
    await flushSave();
    const d = await DB.get(id);
    if (!d) { toast('That meet could not be found', true); return; }
    S = migrate(d); cache = null; dirty = false; ui.evt = null; ui.sel.clear(); ui.q = ''; ui.fCat = ''; ui.fTeam = ''; ui.onlyProblems = false;
    localStorage.setItem(LS_LAST, S.id);
    ui.tab = tab || (S.entries.length ? 'entries' : 'program');
    render();
  }
  /** Add a new meet to the library and open it. */
  async function addMeet(state, tab) {
    await flushSave();
    S = state; cache = null; dirty = true;
    await flushSave();
    localStorage.setItem(LS_LAST, S.id);
    ui.evt = null; ui.sel.clear(); ui.tab = tab || 'program';
    render();
  }


  // ================================================================ sync between computers (folder, e.g. OneDrive)
  const isApp = !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
  const LS_SYNC = 'xcmm.sync';
  const Sync = {
    cfg: (() => { try { return JSON.parse(localStorage.getItem(LS_SYNC)) || {}; } catch (e) { return {}; } })(),
    status: 'off', error: '', last: null, device: 'This computer', files: new Map(), running: false, again: false, soon: null,
    note: '',
  };
  const saveSyncCfg = () => localStorage.setItem(LS_SYNC, JSON.stringify(Sync.cfg));
  const syncOn = () => isApp && Sync.cfg.enabled && Sync.cfg.folder;
  const backend = {
    list: () => invoke('sync_list', { folder: Sync.cfg.folder }),
    read: name => invoke('sync_read', { folder: Sync.cfg.folder, name }),
    write: (name, contents) => invoke('sync_write', { folder: Sync.cfg.folder, name, contents }),
    remove: name => invoke('sync_remove', { folder: Sync.cfg.folder, name }),
  };
  function syncSoon(ms = 2500) { if (!syncOn()) return; clearTimeout(Sync.soon); Sync.soon = setTimeout(() => syncNow(), ms); }
  function setSync(status, error) { Sync.status = status; Sync.error = error || ''; renderChrome(); }
  const hist = arr => [...new Set(arr.filter(Boolean))].slice(-60);
  async function pushMeet(id, merged = []) {
    const meta = await DB.getMeta(id);
    if (!meta) return false;
    const ancestors = hist([...(meta.history || []), ...merged]);
    const base = { format: 'xc-meet-sync', v: 1, id, rev: meta.rev, ancestors, updatedAt: meta.at || new Date().toISOString(), device: Sync.device, app: APP_VERSION };
    let doc;
    if (meta.deleted) doc = { ...base, deleted: true };
    else {
      const st = await DB.get(id); if (!st) return false;
      doc = { ...base, title: st.settings.title, date: st.settings.date, state: st };
    }
    await backend.write(id + '.json', JSON.stringify(doc));
    Sync.files.delete(id + '.json');
    const m2 = await DB.getMeta(id);
    if (m2) await DB.putMeta({ ...m2, baseRev: meta.rev, history: hist([...ancestors, meta.rev]), dirty: m2.rev !== meta.rev });
    return true;
  }
  const comparable = st => { const c = migrate(clone(st)); delete c.conflictOf; c.id = ''; c.entries = c.entries.map(({ uid, ...e }) => e); return X.stableStringify(c); };
  async function sameContent(id, doc) {
    if (!doc || !doc.state) return false;
    const mine = await DB.get(id);
    return !!mine && comparable(mine) === comparable(doc.state);
  }
  /** Keep a version that lost a conflict as its own meet, with an id/rev both computers agree on. */
  async function keepCopy(state, origId, rev, device, at) {
    const cid = `${origId}~${rev}`;
    if (summaries.some(m => m.id === cid) || await DB.get(cid)) return false;
    const st = migrate({ ...state, id: cid });
    st.id = cid; st.conflictOf = origId;
    st.settings.title = `${st.settings.title.replace(/ \(version from .*\)$/, '')} (version from ${device || 'the other computer'})`;
    await DB.put(st, { copyRev: 'c' + rev, at });
    return true;
  }
  async function syncNow() {
    if (!syncOn()) return;
    if (Sync.running) { Sync.again = true; return; }
    Sync.running = true; Sync.again = false; setSync('syncing');
    try {
      await flushSave();
      const files = await backend.list();
      const seen = new Set();
      for (const f of files) {
        seen.add(f.name);
        const c = Sync.files.get(f.name);
        if (c && c.modified === f.modified && c.size === f.size) continue;
        try {
          const doc = JSON.parse(await backend.read(f.name));
          if (doc && doc.format === 'xc-meet-sync' && doc.id && doc.rev) Sync.files.set(f.name, { modified: f.modified, size: f.size, doc });
          else Sync.files.delete(f.name);
        } catch (e) { Sync.files.delete(f.name); } // half-downloaded or not ours: try again next time
      }
      for (const k of [...Sync.files.keys()]) if (!seen.has(k)) Sync.files.delete(k);
      const remotes = [...Sync.files.entries()].map(([file, { doc }]) => ({ file, id: doc.id, rev: doc.rev, deleted: !!doc.deleted, updatedAt: doc.updatedAt || '', ancestors: doc.ancestors || [] }));
      const locals = new Map((await DB.allMeta()).map(m => [m.id, m]));
      for (const sm of summaries) if (!locals.has(sm.id)) { const m = { id: sm.id, rev: newRev(), baseRev: null, dirty: true, at: sm.updatedAt || new Date().toISOString(), history: [] }; await DB.putMeta(m); locals.set(sm.id, m); }
      const actions = X.planSync(locals, remotes);
      Sync.log = (Sync.log || []).concat([{ at: new Date().toISOString(), locals: [...locals.values()].map(m => ({ id: m.id, rev: m.rev, baseRev: m.baseRev, dirty: m.dirty, deleted: m.deleted })), remotes: remotes.map(r => ({ file: r.file, rev: r.rev, anc: r.ancestors })), actions }]).slice(-30);
      const docOf = file => (Sync.files.get(file) || {}).doc;
      let openChange = '', fromDevice = '', pulled = 0, copies = 0;
      const busyHere = () => { const a = document.activeElement; return !!($('#modal-root').children.length || (a && a !== document.body && a.closest && a.closest('#view') && a.matches('input,textarea,select'))); };
      const unchanged = async id => {
        if (S && S.id === id && (dirty || busyHere())) { Sync.again = true; return false; } // don't swap the meet out from under someone typing
        const m = await DB.getMeta(id); const L = locals.get(id); return !L || !m || m.rev === L.rev;
      };
      for (const a of actions) {
        const syncOpts = doc => ({ syncRev: doc.rev, at: doc.updatedAt || '', history: hist([...(doc.ancestors || []), doc.rev]) });
        if (a.type === 'pull') {
          const doc = docOf(a.file); if (!doc || !doc.state || !(await unchanged(a.id))) continue;
          await DB.put(migrate({ ...doc.state, id: a.id }), syncOpts(doc)); pulled++;
          if (S && S.id === a.id) { openChange = 'updated'; fromDevice = doc.device; }
        } else if (a.type === 'deleteLocal' || a.type === 'tombstone') {
          const doc = docOf(a.file) || { rev: a.rev };
          if (!(await unchanged(a.id))) continue;
          await DB.del(a.id, syncOpts(doc)); pulled++;
          if (a.type === 'deleteLocal' && S && S.id === a.id) { openChange = 'deleted'; fromDevice = doc.device; }
        } else if (a.type === 'copyRemote') {
          const doc = docOf(a.file); if (!doc || doc.deleted || !doc.state) continue;
          if (await sameContent(a.id, doc)) continue;
          if (await keepCopy(doc.state, a.id, doc.rev, doc.device, doc.updatedAt)) { copies++; Sync.again = true; }
        } else if (a.type === 'copyLocal') {
          const mine = await DB.get(a.id); const meta = await DB.getMeta(a.id);
          if (!(await unchanged(a.id))) continue;
          if (await sameContent(a.id, docOf(a.file))) continue;
          if (mine && meta && meta.rev === a.rev && await keepCopy(mine, a.id, a.rev, Sync.device, meta.at)) { copies++; Sync.again = true; }
        } else if (a.type === 'push') {
          await pushMeet(a.id, a.merged || []);
        } else if (a.type === 'copy') {
          const doc = docOf(a.from); if (doc) { await backend.write(a.to, JSON.stringify(doc)); Sync.files.delete(a.to); }
        } else if (a.type === 'remove') {
          await backend.remove(a.file); Sync.files.delete(a.file);
        }
      }
      if (pulled || copies) await refreshSummaries();
      if (openChange === 'updated') { const d = await DB.get(S.id); if (d) { S = migrate(d); cache = null; } toast(`This meet was updated with changes from ${fromDevice || 'your other computer'}`); }
      if (openChange === 'deleted') { S = null; ui.tab = 'meets'; toast(`This meet was deleted on ${fromDevice || 'your other computer'}`); }
      if (copies) toast(`${copies} meet${copies > 1 ? 's were' : ' was'} changed on both computers — both versions are kept on the Meets tab`);
      Sync.last = new Date(); setSync('ok');
      if (openChange || ((pulled || copies) && ui.tab === 'meets')) render();
    } catch (e) {
      setSync('error', String(e && e.message || e));
    } finally {
      Sync.running = false;
      if (Sync.again) setTimeout(syncNow, 3000);
    }
  }
  async function enableSync(folder) {
    Sync.cfg = { ...Sync.cfg, enabled: true, folder, asked: true }; saveSyncCfg();
    Sync.files.clear();
    try {
      await backend.write('README.txt', 'This folder keeps XC Meet Manager in sync between your computers.\r\nEach file is one meet. Please don\'t edit, rename or move these files.\r\n');
    } catch (e) { setSync('error', String(e.message || e)); toast('Could not use that folder: ' + (e.message || e), true); return; }
    await syncNow();
    if (Sync.status === 'ok') toast('Sync is on');
  }
  async function chooseSyncFolder() {
    const f = await invoke('pick_folder');
    if (f) await enableSync(f);
  }
  function syncChipText() {
    if (!isApp) return '';
    if (!Sync.cfg.enabled) return '☁ Sync off';
    if (Sync.status === 'syncing') return '☁ Syncing…';
    if (Sync.status === 'error') return '⚠ Sync problem';
    if (Sync.last) return '☁ Synced ' + Sync.last.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' });
    return '☁ Sync on';
  }
  async function syncDialog() {
    const def = await invoke('sync_default_folder').catch(() => null);
    const on = Sync.cfg.enabled;
    const body = `<p style="margin-top:0">Keep every meet the same on all your computers. Meets are saved to a folder in <b>OneDrive</b>, and OneDrive copies them between computers whenever there's internet.</p>
      <ul class="small" style="line-height:1.6;padding-left:18px">
        <li>No internet at the event? Keep working as normal — everything syncs once the laptop is back online and the app is opened.</li>
        <li>Turn sync on with the <b>same folder</b> on each computer.</li>
        <li>If the same meet is changed on both computers before they sync, both versions are kept so nothing is lost.</li>
      </ul>
      ${on ? `<div class="notice ${Sync.status === 'error' ? 'err' : ''}"><b>Sync is on</b> · ${esc(Sync.device)}<br><span class="small">Folder: ${esc(Sync.cfg.folder)}</span><br><span class="small">${Sync.status === 'error' ? 'Problem: ' + esc(Sync.error) : Sync.last ? 'Last synced ' + esc(Sync.last.toLocaleString('en-IE')) : ''}</span></div>`
        : def ? `<div class="notice">OneDrive folder found:<br><b class="small">${esc(def)}</b></div>` : `<div class="notice warn">OneDrive wasn't found on this computer. Sign in to OneDrive first, or choose any folder that's shared between your computers.</div>`}`;
    modal('Sync between computers', body, {
      footer: on ? `<button class="btn danger" data-off>Turn sync off</button><span class="spacer"></span><button class="btn" data-pick>Change folder…</button><button class="btn primary" data-now>Sync now</button>`
        : `<button class="btn" data-later>Not now</button><span class="spacer"></span><button class="btn" data-pick>Choose a folder…</button>${def ? '<button class="btn primary" data-on>Turn on sync with OneDrive</button>' : ''}`,
      onMount: m => {
        const b = sel => $(sel, m.el);
        if (b('[data-off]')) b('[data-off]').onclick = () => { Sync.cfg.enabled = false; saveSyncCfg(); setSync('off'); m.close(); toast('Sync is off on this computer'); };
        if (b('[data-now]')) b('[data-now]').onclick = async () => { m.close(); await syncNow(); if (Sync.status === 'ok') toast('Synced'); };
        if (b('[data-pick]')) b('[data-pick]').onclick = async () => { m.close(); await chooseSyncFolder(); };
        if (b('[data-on]')) b('[data-on]').onclick = async () => { m.close(); await enableSync(def); };
        if (b('[data-later]')) b('[data-later]').onclick = () => { Sync.cfg.asked = true; saveSyncCfg(); m.close(); };
      },
      onClose: () => { if (!Sync.cfg.asked) { Sync.cfg.asked = true; saveSyncCfg(); } },
    });
  }
  async function startSync() {
    if (!isApp) return;
    Sync.device = await invoke('device_name').catch(() => 'This computer');
    setInterval(() => syncNow(), 15000);
    window.addEventListener('focus', () => syncSoon(300));
    if (syncOn()) { await syncNow(); return; }
    if (!Sync.cfg.asked) syncDialog();
  }

  // ================================================================ files
  const fileTypes = [{ description: 'XC Meet file', accept: { 'application/json': ['.json'] } }];
  const safeName = s => (s || 'meet').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'meet';
  async function saveJson(name, data) {
    if (isApp) { download(name, data, 'application/json'); return; }
    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: fileTypes });
        const w = await h.createWritable(); await w.write(data); await w.close(); toast('Saved ' + h.name); return;
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    download(name, data, 'application/json');
  }
  async function exportMeetFile(state) {
    state = state || S;
    await saveJson(safeName(`${state.settings.date || ''} ${state.settings.title}`) + '.json', JSON.stringify({ ...state, app: 'XC Meet Manager', appVersion: APP_VERSION, savedAt: new Date().toISOString() }, null, 1));
  }
  async function backupAll() {
    await flushSave();
    const all = await DB.all();
    await saveJson(`XC Meet Manager backup ${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ app: 'XC Meet Manager', kind: 'backup', appVersion: APP_VERSION, savedAt: new Date().toISOString(), meets: all }));
    localStorage.setItem(LS_BACKUP, new Date().toISOString()); render();
  }
  /** Import a meet file or a full backup into the library. */
  async function importText(text, name) {
    let d; try { d = JSON.parse(text); } catch (e) { toast(name + ' is not a meet file or backup', true); return; }
    const list = d.kind === 'backup' && Array.isArray(d.meets) ? d.meets : (d.entries && d.settings ? [d] : null);
    if (!list) { toast(name + ' is not a meet file or backup', true); return; }
    const existing = new Set(summaries.map(x => x.id));
    let added = 0, replaced = 0, last = null;
    for (const m of list) {
      const st = migrate(m);
      if (existing.has(st.id)) {
        if (list.length === 1 && !confirm(`“${st.settings.title}” is already in your meets. Replace it with the copy from the file?\n\nChoose Cancel to keep both.`)) st.id = newMeetId();
        else replaced++;
      } else added++;
      if (S && st.id === S.id) { S = st; cache = null; }
      await DB.put(st); last = st;
    }
    await refreshSummaries();
    if (list.length === 1) { await openMeet(last.id); toast('Opened ' + last.settings.title); }
    else { render(); toast(`Restored ${list.length} meets (${added} new, ${replaced} updated)`); }
  }
  async function pickImportMeet() {
    if (window.showOpenFilePicker) {
      try {
        const hs = await window.showOpenFilePicker({ types: fileTypes, multiple: true });
        for (const h of hs) { const f = await h.getFile(); await importText(await f.text(), f.name); }
        return;
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    $('#file-open').click();
  }
  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
    if (isApp) {
      const r = new FileReader();
      r.onload = async () => {
        try { const path = await invoke('save_file', { name, contentsB64: String(r.result).split(',')[1] || '' }); if (path) toast('Saved ' + path); }
        catch (e) { toast('Could not save: ' + (e.message || e), true); }
      };
      r.readAsDataURL(blob); return;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function downloadXlsx(name, sheets) {
    download(safeName(name) + '.xlsx', new Blob([X.buildXlsx(sheets)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }
  function downloadCsv(name, rows) {
    const csv = rows.map(r => r.map(c => { const v = c && typeof c === 'object' ? c.v : c; const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
    download(safeName(name) + '.csv', '﻿' + csv, 'text/csv');
  }

  // ================================================================ ui helpers
  function toast(msg, err) {
    const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
    $('#toast-root').appendChild(t); setTimeout(() => t.remove(), err ? 6000 : 3000);
  }
  function modal(title, bodyHtml, { wide, footer, onMount, onClose } = {}) {
    const root = $('#modal-root');
    const back = document.createElement('div'); back.className = 'modal-back';
    back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog"><header><h3>${esc(title)}</h3><button class="btn icon" data-close aria-label="Close">✕</button></header><div class="body">${bodyHtml}</div>${footer ? `<footer>${footer}</footer>` : ''}</div>`;
    root.appendChild(back);
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(); };
    const onKey = e => { if (e.key === 'Escape' && root.lastElementChild === back) { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', e => { if (e.target === back) back.dataset.down = '1'; });
    back.addEventListener('click', e => { if (e.target === back && back.dataset.down) close(); back.dataset.down = ''; });
    $('[data-close]', back).onclick = close;
    const m = { el: back, body: $('.body', back), foot: $('footer', back), close };
    onMount && onMount(m);
    return m;
  }
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label == null ? v : label)}</option>`;
  function catOptions(selected, { blank = true, blankLabel = '— choose —' } = {}) {
    const d = derive();
    const inProg = S.ageCategories.filter(c => d.progCats.has(c.name)).map(c => c.name);
    const others = S.ageCategories.filter(c => !d.progCats.has(c.name)).map(c => c.name);
    let h = blank ? opt('', blankLabel, !selected) : '';
    if (selected && !d.catByName.has(selected)) h += opt(selected, selected + ' (unknown)', true);
    if (inProg.length) h += `<optgroup label="In program">${inProg.map(c => opt(c, c, c === selected)).join('')}</optgroup>`;
    h += `<optgroup label="${inProg.length ? 'Other categories' : 'Categories'}">${others.map(c => opt(c, c, c === selected)).join('')}</optgroup>`;
    return h;
  }
  const listOptions = (list, selected, blankLabel = '—') => opt('', blankLabel, !selected) + (selected && !list.includes(selected) ? opt(selected, selected + ' (unknown)', true) : '') + list.map(x => opt(x, x, x === selected)).join('');
  const teamDatalist = () => `<datalist id="dl-teams">${S.teams.map(t => `<option value="${esc(t.name)}">`).join('')}</datalist>`;
  const regionCounty = () => S.settings.regionLevel === 'National' || S.settings.regionLevel === 'Provincial';
  const regionProvince = () => S.settings.regionLevel === 'National';
  function eventLabel(ev) { return `Event ${ev.number} · ${ev.distance || ''} ${ev.categories.join(' / ')}`.replace(/\s+/g, ' '); }
  function entriesFor(ev) { const cs = new Set(ev.categories); return S.entries.filter(e => cs.has(e.category)); }
  const byId = () => new Map(S.entries.map(e => [String(e.id), e]));
  function nextId(used) {
    let m = (+S.settings.startId || 1) - 1;
    for (const e of S.entries) if (e.id != null && +e.id > m) m = +e.id;
    if (used) for (const u of used) if (+u > m) m = +u;
    return m + 1;
  }
  function surnameKey(name) { const [f, l] = X.splitFullName(name); return (l + ' ' + f).toLowerCase(); }
  function header() {
    const st = S.settings;
    const date = st.date ? new Date(st.date + 'T00:00:00').toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
    return `<h1>${esc(st.title)}</h1><div class="rh">${esc([st.venue, date, st.time && 'Start ' + st.time].filter(Boolean).join(' · '))}</div>`;
  }
  function printHtml(html) {
    $('#print-root').innerHTML = `<div class="report">${html}</div>`;
    setTimeout(() => window.print(), 50);
  }

  // ================================================================ chrome
  function fmtDate(iso, long) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-IE', long ? { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function renderChrome() {
    $('#comp-title').textContent = S ? [S.settings.title, fmtDate(S.settings.date, true)].filter(Boolean).join(' · ') : 'No meet open';
    const ss = $('#save-status');
    ss.textContent = !S ? '' : dirty ? '● Saving…' : '✓ Saved';
    ss.className = 'save-status' + (dirty ? ' dirty' : '');
    $$('#tabs button').forEach(b => { b.classList.toggle('active', b.dataset.tab === ui.tab); b.disabled = !S && b.dataset.tab !== 'meets'; });
    $$('[data-needs-meet]').forEach(b => { b.disabled = !S; });
    const be = $('#badge-entries');
    if (S) {
      const errs = derive().issues.filter(i => i.level === 'error').length;
      be.textContent = errs ? errs + ' ⚠' : S.entries.length;
      be.className = 'badge' + (errs ? ' err' : '');
    } else be.textContent = '';
    $('#badge-meets').textContent = summaries.length || '';
    const chip = $('#sync-chip');
    if (chip) { chip.hidden = !isApp; chip.textContent = syncChipText(); chip.className = 'btn ghost sync-chip ' + (Sync.status === 'error' && Sync.cfg.enabled ? 'err' : ''); chip.title = Sync.cfg.enabled ? (Sync.error || 'Syncing via ' + Sync.cfg.folder) : 'Set up sync between computers'; }
    document.title = S ? S.settings.title + ' — XC Meet Manager' : 'XC Meet Manager';
  }
  function render() {
    if (!S && ui.tab !== 'meets') ui.tab = 'meets';
    renderChrome();
    const v = $('#view');
    const scroll = v.scrollTop;
    const views = { meets: viewMeets, comp: viewComp, program: viewProgram, entries: viewEntries, lists: viewLists, results: viewResults, setup: viewSetup };
    v.innerHTML = `<div class="wrap">${views[ui.tab]()}</div>`;
    v.scrollTop = scroll;
    const after = { meets: afterMeets, entries: afterEntries, results: afterResults, setup: afterSetup };
    after[ui.tab] && after[ui.tab]();
  }

  // ================================================================ meets
  function viewMeets() {
    const q = X.lc(ui.meetQ);
    const today = new Date().toISOString().slice(0, 10);
    const list = summaries.filter(m => !q || X.lc(m.title).includes(q) || X.lc(m.venue).includes(q) || (m.date || '').includes(q));
    const upcoming = list.filter(m => m.date && m.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    const past = list.filter(m => !m.date || m.date < today);
    const byYear = new Map();
    for (const m of past) { const y = m.date ? m.date.slice(0, 4) : 'No date'; if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(m); }
    const lastBackup = localStorage.getItem(LS_BACKUP);
    const row = m => `<tr class="clickable${S && S.id === m.id ? ' current' : ''}" data-meet="${esc(m.id)}">
        <td style="white-space:nowrap"><b>${esc(fmtDate(m.date) || '—')}</b></td>
        <td><b>${esc(m.title)}</b>${S && S.id === m.id ? ' <span class="pill ok">open</span>' : ''}${m.conflictOf ? ' <span class="pill warn" title="This meet was changed on both computers before they synced. This is the earlier of the two versions, kept so nothing is lost.">kept copy</span>' : ''}<div class="small muted">${esc(m.venue || '')}</div></td>
        <td class="num">${m.races}</td><td class="num">${m.athletes}</td><td class="num">${m.finishers}</td>
        <td class="small muted" style="white-space:nowrap">${esc(new Date(m.updatedAt).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td>
        <td style="white-space:nowrap" data-nosel><button class="btn small primary" data-act="meet-open" data-id="${esc(m.id)}">Open</button> <button class="btn small" data-act="meet-copy" data-id="${esc(m.id)}" title="Start a new meet with the same races and settings">Copy as new…</button> <button class="btn small" data-act="meet-export" data-id="${esc(m.id)}" title="Save this meet to a file">Export</button> <button class="btn small danger" data-act="meet-del" data-id="${esc(m.id)}" title="Delete">✕</button></td>
      </tr>`;
    const table = rows => `<div class="tbl-wrap" style="max-height:none"><table class="t meets-table"><thead><tr><th style="width:120px">Date</th><th>Meet</th><th class="num">Races</th><th class="num">Athletes</th><th class="num">Finishers</th><th>Last changed</th><th style="width:330px"></th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>`;
    return `<div class="row" style="align-items:flex-end;margin-bottom:12px"><div><h2>Meets</h2><p class="sub" style="margin:0">Every meet is kept here. Click one to open it — older meets stay available to look back at, reprint or copy.</p></div><span class="spacer"></span>
        <button class="btn primary" data-act="meet-new" style="font-size:15px;padding:9px 18px">+ New meet</button></div>
      <div class="toolbar"><input type="search" id="meet-q" placeholder="Search meets…" value="${esc(ui.meetQ)}" style="width:240px"><span class="spacer"></span>
        <button class="btn small" data-act="meet-import-xlsx" title="Import a whole meet from an Excel meet workbook (.xlsm / .xlsx)">Import Excel workbook…</button>
        <button class="btn small" data-act="meet-import">Import meet file…</button>
        <button class="btn small" data-act="meet-backup" ${summaries.length ? '' : 'disabled'}>Back up all meets</button>
        <span class="small muted">${lastBackup ? 'Last backup ' + esc(new Date(lastBackup).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })) : summaries.length ? 'Not backed up yet' : ''}</span></div>
      ${summaries.some(m => m.conflictOf) ? `<div class="notice warn"><b>Some meets were changed on both computers before they could sync.</b> The later version is kept as normal and the earlier one is kept too, marked <span class="pill warn">kept copy</span>. Check them, then delete the one you don't need.</div>` : ''}
      ${isApp && !Sync.cfg.enabled ? `<div class="notice small">☁ Use this on more than one computer? <a href="#" data-act="sync-open">Turn on sync with OneDrive</a> to keep your meets the same everywhere.</div>` : ''}
      ${!summaries.length ? `<div class="card empty"><p style="font-size:17px;margin-top:0">No meets yet</p><p>Create your first meet — just give it a name and date.</p>
          <div class="row" style="justify-content:center"><button class="btn primary" data-act="meet-new">+ New meet</button><button class="btn" data-act="meet-import-xlsx">Import an Excel meet workbook…</button><button class="btn" data-act="load-sample">Add an example meet to try it out</button><button class="btn" data-act="meet-import">Import meet file…</button></div></div>`
        : !list.length ? '<div class="card empty">No meets match your search.</div>' : `
        ${upcoming.length ? `<h3>Upcoming</h3>${table(upcoming)}` : ''}
        ${[...byYear.entries()].map(([y, ms]) => `<h3>${esc(y)}</h3>${table(ms)}`).join('')}`}`;
  }
  function afterMeets() {
    const q = $('#meet-q');
    if (q) q.oninput = () => { ui.meetQ = q.value; const p = q.selectionStart; render(); const q2 = $('#meet-q'); q2.focus(); q2.setSelectionRange(p, p); };
    $$('tr[data-meet]').forEach(tr => tr.addEventListener('click', e => { if (!e.target.closest('[data-nosel]')) openMeet(tr.dataset.meet); }));
  }
  /** A blank meet whose clubs/categories/spellings come from the most recently changed meet (or the saved default). */
  async function baseState() {
    const st = blankState();
    const recent = [...summaries].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
    const refSrc = recent ? await DB.get(recent.id) : null;
    if (refSrc && !localStorage.getItem(LS_REF)) for (const k of ['ageCategories', 'mastersTeamCategories', 'teams', 'counties', 'provinces', 'aliases']) if (refSrc[k]) st[k] = clone(refSrc[k]);
    return st;
  }

  // ---------------------------------------------------------------- import a whole meet workbook (.xlsm)
  function pickWorkbook() {
    const inp = $('#file-import');
    inp.value = '';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        toast('Reading ' + f.name + '…');
        const sheets = await X.readXlsx(await f.arrayBuffer());
        if (!X.isMeetWorkbook(sheets)) { toast(f.name + ' has no Program and Entries sheets — use “Paste athletes” or “Import file” on the Athletes tab instead', true); return; }
        workbookDialog(sheets, f.name);
      } catch (e) { toast('Could not read ' + f.name + ': ' + e.message, true); }
    };
    inp.click();
  }
  function workbookDialog(sheets, fileLabel) {
    const { meet, report } = X.importWorkbook(sheets);
    const st0 = meet.settings;
    const dupe = summaries.find(m => X.lc(m.title) === X.lc(st0.title) && m.date === st0.date);
    const lateN = report.lateEntries.length;
    const body = `<p class="small muted" style="margin-top:0">From <b>${esc(fileLabel)}</b></p>
      <div class="row" style="margin-bottom:12px">
        <div class="stat"><b>${report.races}</b><span>races</span></div><div class="stat"><b>${report.athletes}</b><span>athletes</span></div>
        <div class="stat"><b>${report.finishers}</b><span>finishers on ${report.resultSheets} results sheets</span></div>
        <div class="stat"><b>${report.clubs}</b><span>clubs</span></div><div class="stat"><b>${report.categories}</b><span>age categories</span></div>
      </div>
      <div class="form-grid" style="grid-template-columns:2fr 1fr">
        <label class="f">Meet name<input type="text" name="title" value="${esc(st0.title)}"></label>
        <label class="f">Date<input type="date" name="date" value="${esc(st0.date)}"></label>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:12px">
        <label class="chk"><input type="checkbox" name="ref" ${report.categories && report.clubs ? 'checked' : 'disabled'}> Use this workbook's clubs, age categories and team sizes ${report.categories && report.clubs ? '' : '<span class="muted small">(none found in the workbook)</span>'}</label>
        ${lateN ? `<label class="chk"><input type="checkbox" name="late" checked> Add ${lateN} athlete${lateN > 1 ? 's who only appear' : ' who only appears'} on the results sheets (late entries)</label>
          <div class="small muted" style="margin:-4px 0 0 24px">${report.lateEntries.slice(0, 6).map(e => `#${esc(e.id)} ${esc(e.name)} (${esc(e.category || '?')})`).join(', ')}${lateN > 6 ? ', …' : ''}</div>` : ''}
      </div>
      ${report.warnings.length ? `<div class="notice warn small" style="margin-top:12px">${report.warnings.map(esc).join('<br>')}</div>` : ''}
      ${dupe ? `<div class="notice warn small" style="margin-top:12px">You already have “${esc(dupe.title)}” on ${esc(fmtDate(dupe.date))}. Importing creates a second copy — the existing one isn't changed.</div>` : ''}
      <p class="small muted" style="margin-bottom:0">Nothing in the workbook is changed. After importing, the Athletes tab shows anything that needs checking.</p>`;
    modal('Import meet workbook', body, {
      wide: true, footer: '<button class="btn" data-c>Cancel</button><button class="btn primary" data-ok>Import as a new meet</button>', onMount: m => {
        const f = n => $(`[name=${n}]`, m.body);
        $('[data-c]', m.el).onclick = m.close;
        $('[data-ok]', m.el).onclick = async () => {
          const st = await baseState();
          if (f('ref').checked) for (const k of ['ageCategories', 'teams', 'mastersTeamCategories', 'counties', 'provinces']) if (meet[k] && meet[k].length) st[k] = meet[k];
          // make sure categories / counties used by the workbook exist even when keeping current reference data
          for (const c of meet.counties) if (!st.counties.includes(c)) st.counties.push(c);
          Object.assign(st.settings, meet.settings, { title: f('title').value.trim() || meet.settings.title, date: f('date').value || meet.settings.date });
          st.program = meet.program; st.results = meet.results;
          const entries = [...meet.entries, ...(lateN && f('late').checked ? report.lateEntries : [])];
          const done = migrate({ ...st, entries });
          m.close();
          await addMeet(done, 'entries');
          toast(`Imported “${done.settings.title}”: ${done.entries.length} athletes, ${report.finishers} finishers`);
        };
      },
    });
  }

  async function newMeetDialog(copyFromId) {
    await flushSave();
    const today = new Date().toISOString().slice(0, 10);
    const src = copyFromId ? summaries.find(m => m.id === copyFromId) : null;
    const body = `<div class="form-grid" style="grid-template-columns:2fr 1fr">
        <label class="f">Meet name<input type="text" name="title" placeholder="e.g. Cork County Juvenile XC" value="${esc(src ? src.title : '')}"></label>
        <label class="f">Date<input type="date" name="date" value="${esc(today)}"></label>
        <label class="f">Venue <span class="muted" style="font-weight:400">(optional)</span><input type="text" name="venue" value="${esc(src ? src.venue : '')}"></label>
        <span></span>
        <label class="f" style="grid-column:1/-1">Races &amp; settings<select name="from">
          ${opt('', 'Start with an empty program', !src)}
          ${summaries.map(m => opt(m.id, `Copy races & settings from: ${m.title}${m.date ? ' (' + fmtDate(m.date) + ')' : ''}`, src && src.id === m.id)).join('')}
        </select></label>
      </div>
      <p class="small muted" style="margin-bottom:0">Clubs, age categories and remembered club spellings carry over from your most recent meet. Athletes and results always start empty.</p>`;
    modal(src ? 'Copy as a new meet' : 'New meet', body, {
      footer: '<button class="btn" data-c>Cancel</button><button class="btn primary" data-ok>Create meet</button>', onMount: m => {
        const f = n => $(`[name=${n}]`, m.body);
        f('title').focus(); if (src) f('title').select();
        $('[data-c]', m.el).onclick = m.close;
        const go = async () => {
          const title = f('title').value.trim(), date = f('date').value, venue = f('venue').value.trim(), from = f('from').value;
          if (!title) { toast('Give the meet a name', true); f('title').focus(); return; }
          const st = await baseState();
          if (from) {
            const t = migrate(await DB.get(from));
            st.program = clone(t.program);
            const keep = { ...t.settings }; Object.assign(st.settings, keep);
            for (const k of ['ageCategories', 'mastersTeamCategories', 'teams', 'counties', 'provinces', 'aliases']) st[k] = clone(t[k]);
          }
          Object.assign(st.settings, { title, date, venue, year: date ? +date.slice(0, 4) : st.settings.year });
          m.close();
          await addMeet(st, from ? 'entries' : 'program');
          toast(`Created “${title}”`);
        };
        $('[data-ok]', m.el).onclick = go;
        m.body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); go(); } });
      },
    });
  }

  // ================================================================ 1. competition
  function viewComp() {
    const st = S.settings;
    const nRes = Object.values(S.results).reduce((a, r) => a + r.length, 0);
    const clubs = new Set(S.entries.map(e => e.team).filter(Boolean)).size;
    const f = (key, label, type = 'text', extra = '') => `<label class="f">${label}<input type="${type}" data-set="${key}" value="${esc(st[key] ?? '')}" ${extra}></label>`;
    return `
    <h2>Competition</h2><p class="sub">Details for this meet, used on every sheet and printout. Work through the numbered tabs left to right.</p>
    <div class="row" style="margin-bottom:14px">
      <div class="stat"><b>${S.program.length}</b><span>races on program</span></div>
      <div class="stat"><b>${S.entries.length}</b><span>athletes entered</span></div>
      <div class="stat"><b>${clubs}</b><span>clubs</span></div>
      <div class="stat"><b>${nRes}</b><span>finishers recorded</span></div>
    </div>
    <div class="grid g2">
      <div class="card">
        <h3 style="margin-top:0">Details</h3>
        <div class="form-grid">
          ${f('title', 'Competition name', 'text', 'style="grid-column:1/-1"')}
          ${f('venue', 'Venue')}${f('date', 'Date', 'date')}${f('time', 'Start time')}
          ${f('year', 'Year of competition (age groups)', 'number', 'min="1990" max="2100"')}
        </div>
        <h3>Scoring</h3>
        <div class="form-grid">
          <label class="f">Competition level<select data-set="regionLevel">${['Club', 'County', 'Provincial', 'National'].map(x => opt(x, x, st.regionLevel === x)).join('')}</select></label>
          ${f('region', 'Region (e.g. Munster)')}
        </div>
        <p class="small muted">Club teams are always scored. County teams are scored at Provincial and National level; province teams only at National level.</p>
        <label class="chk"><input type="checkbox" data-set="unknownTakesPosition" ${st.unknownTakesPosition ? 'checked' : ''}> Unknown / wrong-race numbers still take a finishing position</label>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Numbers &amp; names</h3>
        <div class="form-grid">
          ${f('startId', 'First athlete number', 'number', 'min="0"')}
          ${f('checkInExtraRows', 'Blank rows on check-in sheets', 'number', 'min="0" max="40"')}
        </div>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
          <label class="chk"><input type="checkbox" data-set="autoNumber" ${st.autoNumber ? 'checked' : ''}> Automatically number new athletes</label>
          <label class="chk"><input type="checkbox" data-set="upperSurname" ${st.upperSurname ? 'checked' : ''}> Format pasted names as “First SURNAME”</label>
        </div>
        <h3>This meet</h3>
        <p class="small muted">Changes save automatically. All your meets are listed on the <b>Meets</b> tab.</p>
        <div class="row">
          <button class="btn" data-act="meet-export-cur">Export meet file…</button>
          <button class="btn" data-act="meet-copy-cur">Copy as new meet…</button>
          <button class="btn danger" data-act="meet-del-cur">Delete this meet</button>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">How it works</h3>
      <ol class="small" style="line-height:1.7;margin:0;padding-left:18px">
        <li><b>Program</b> — add the races and which age categories run in each (several categories can share one race).</li>
        <li><b>Athletes</b> — click <b>Paste athletes</b>, then copy the entry list from the website and paste it. Columns, clubs and age categories are matched automatically; you confirm anything it isn't sure about.</li>
        <li><b>Lists</b> — print the booklet, club lists and check-in sheets.</li>
        <li><b>Results</b> — type bib numbers in finishing order (or paste the finish list from the timing system). Club, county and province team scores update instantly.</li>
      </ol>
    </div>`;
  }

  // ================================================================ 2. program
  function viewProgram() {
    const d = derive();
    const used = new Map();
    S.program.forEach(p => p.categories.forEach(c => used.set(c, (used.get(c) || 0) + 1)));
    const rows = S.program.map((p, i) => {
      const n = entriesFor(p).length;
      const dupl = p.categories.filter(c => used.get(c) > 1);
      return `<tr>
        <td style="width:70px"><input type="number" style="width:60px" data-pf="number" data-i="${i}" value="${esc(p.number)}"></td>
        <td>${p.categories.map((c, ci) => `<span class="pill ${dupl.includes(c) ? 'warn' : d.catByName.has(c) ? '' : 'err'}" title="${dupl.includes(c) ? 'This category is in more than one race' : ''}">${esc(c)}<span class="x" data-act="prog-delcat" data-i="${i}" data-ci="${ci}" title="Remove">×</span></span>`).join('')}
          <select data-act="prog-addcat" data-i="${i}" style="max-width:170px"><option value="">+ add category</option>${catOptions('', { blank: false })}</select></td>
        <td><select data-pf="type" data-i="${i}">${opt('CC', 'Cross country', p.type === 'CC')}${opt('RR', 'Road race', p.type === 'RR')}</select></td>
        <td><input type="text" style="width:100px" data-pf="distance" data-i="${i}" value="${esc(p.distance)}"></td>
        <td><input type="text" style="width:80px" data-pf="time" data-i="${i}" value="${esc(p.time)}" placeholder="hh:mm"></td>
        <td class="num">${n}</td>
        <td class="num">${(S.results[p.number] || []).length}</td>
        <td style="white-space:nowrap"><button class="btn icon" data-act="prog-up" data-i="${i}" ${i ? '' : 'disabled'}>↑</button><button class="btn icon" data-act="prog-down" data-i="${i}" ${i < S.program.length - 1 ? '' : 'disabled'}>↓</button><button class="btn icon danger" data-act="prog-del" data-i="${i}">✕</button></td>
      </tr>`;
    }).join('');
    return `<h2>Program</h2><p class="sub">Each row is one race. Put several age categories in the same race when they run together — they are still ranked and team-scored separately.</p>
      <div class="toolbar"><button class="btn primary" data-act="prog-add">+ Add race</button><button class="btn" data-act="prog-quick">Add one race per category…</button>
      <span class="spacer"></span><button class="btn" data-act="prog-print">Print program</button></div>
      ${S.program.length ? `<div class="tbl-wrap"><table class="t"><thead><tr><th>Event #</th><th>Age categories</th><th>Type</th><th>Distance</th><th>Time</th><th class="num">Entered</th><th class="num">Finishers</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="card empty">No races yet. Click <b>Add one race per category…</b> to build the program quickly.</div>`}`;
  }
  function progQuick() {
    const d = derive();
    const groups = {};
    S.ageCategories.forEach(c => { const g = c.name.match(/^(U\d+|Masters|Intermediate|Novice|Senior|Junior|Minor|Inter)/i); const k = g ? g[1].replace(/^u/, 'U') : 'Other'; (groups[k] = groups[k] || []).push(c); });
    const body = `<p class="small muted">Tick the categories that run. Each one becomes its own race, using the distance from the reference data.</p>
      <div style="columns:3 200px;column-gap:20px">${Object.entries(groups).map(([g, cs]) => `<div style="break-inside:avoid;margin-bottom:10px"><b class="small">${esc(g)}</b><br>${cs.map(c => `<label class="chk small" style="display:flex"><input type="checkbox" value="${esc(c.name)}" ${d.progCats.has(c.name) ? 'disabled checked' : ''}> ${esc(c.name)} <span class="muted">${esc(c.ccDistance || '')}</span></label>`).join('')}</div>`).join('')}</div>`;
    modal('Add one race per category', body, {
      wide: true, footer: `<button class="btn" data-close2>Cancel</button><button class="btn primary" data-ok>Add races</button>`,
      onMount: m => {
        $('[data-close2]', m.el).onclick = m.close;
        $('[data-ok]', m.el).onclick = () => {
          const picked = $$('input:checked:not(:disabled)', m.body).map(i => i.value);
          let n = Math.max(0, ...S.program.map(p => +p.number || 0));
          for (const c of picked) {
            const cfg = d.catByName.get(c);
            S.program.push({ number: ++n, categories: [c], type: 'CC', distance: cfg ? cfg.ccDistance : '', time: '' });
          }
          m.close(); commit(); toast(`Added ${picked.length} races`);
        };
      },
    });
  }
  function programReport() {
    return header() + `<h2>Program</h2><table><thead><tr><th>Event</th><th>Time</th><th>Distance</th><th>Categories</th><th>Entered</th></tr></thead><tbody>${S.program.map(p => `<tr><td>${esc(p.number)}</td><td>${esc(p.time)}</td><td>${esc(p.distance)}</td><td>${esc(p.categories.join(' / '))}</td><td>${entriesFor(p).length}</td></tr>`).join('')}</tbody></table>`;
  }

  // ================================================================ 3. entries
  function filteredEntries() {
    const d = derive();
    const q = X.lc(ui.q);
    let list = S.entries.filter(e => {
      if (ui.fCat === '__none__' ? (e.category && d.catByName.has(e.category)) : (ui.fCat && e.category !== ui.fCat)) return false;
      if (ui.fTeam && e.team !== ui.fTeam) return false;
      if (ui.onlyProblems && !d.issuesByUid.has(e.uid)) return false;
      if (q && !(X.lc(e.name).includes(q) || X.lc(e.team).includes(q) || String(e.id) === q || X.lc(e.reg).includes(q))) return false;
      return true;
    });
    const catIdx = new Map(d.catOrder.map((c, i) => [c, i]));
    const sorters = {
      id: (a, b) => (a.id ?? 1e9) - (b.id ?? 1e9),
      name: (a, b) => surnameKey(a.name).localeCompare(surnameKey(b.name)),
      category: (a, b) => (catIdx.get(a.category) ?? 999) - (catIdx.get(b.category) ?? 999) || a.team.localeCompare(b.team) || surnameKey(a.name).localeCompare(surnameKey(b.name)),
      team: (a, b) => a.team.localeCompare(b.team) || (catIdx.get(a.category) ?? 999) - (catIdx.get(b.category) ?? 999) || surnameKey(a.name).localeCompare(surnameKey(b.name)),
    };
    return list.sort(sorters[ui.sort] || sorters.id);
  }
  function viewEntries() {
    const d = derive();
    const list = filteredEntries();
    const errs = d.issues.filter(i => i.level === 'error'), warns = d.issues.filter(i => i.level === 'warn');
    const teamsUsed = [...new Set(S.entries.map(e => e.team).filter(Boolean))].sort();
    const showMasters = S.entries.some(e => e.mastersTeam || e.mastersCountyTeam) || S.program.some(p => p.categories.some(c => /masters/i.test(c)));
    const showST = S.entries.some(e => e.scoringTeam), showDob = S.entries.some(e => e.dob), showReg = S.entries.some(e => e.reg);
    const fixable = autoFixes().length;
    const cell = (e, f, v) => { const is = (d.issuesByUid.get(e.uid) || []).filter(i => i.field === f); const cls = is.some(i => i.level === 'error') ? 'bad' : is.length ? 'warnc' : ''; return `<td class="${cls}" title="${esc(is.map(i => i.msg).join('\n'))}">${esc(v)}</td>`; };
    const MAX = 1500;
    const rows = list.slice(0, MAX).map(e => `<tr class="clickable" data-uid="${e.uid}">
        <td class="c" data-nosel><input type="checkbox" data-sel="${e.uid}" ${ui.sel.has(e.uid) ? 'checked' : ''}></td>
        ${cell(e, 'id', e.id ?? '')}${cell(e, 'name', e.name)}${cell(e, 'category', e.category)}
        ${cell(e, 'team', e.team)}${showST ? cell(e, 'scoringTeam', e.scoringTeam) : ''}
        ${regionCounty() ? cell(e, 'county', e.county) : ''}${regionProvince() ? cell(e, 'province', e.province) : ''}
        ${showDob ? `<td>${esc(e.dob)}</td>` : ''}${showReg ? `<td>${esc(e.reg)}</td>` : ''}
        ${showMasters ? cell(e, 'mastersTeam', e.mastersTeam) + cell(e, 'mastersCountyTeam', e.mastersCountyTeam) : ''}
      </tr>`).join('');
    const th = (k, l) => `<th data-sort="${k}" style="cursor:pointer">${l}${ui.sort === k ? ' ▾' : ''}</th>`;
    return `<h2>Athletes</h2><p class="sub">Copy an entry list from any website or spreadsheet and paste it in. Click a row to edit an athlete.</p>
      ${errs.length ? `<div class="notice err"><b>${errs.length} problem${errs.length > 1 ? 's' : ''}</b> to fix (red cells) ${warns.length ? `and ${warns.length} warning${warns.length > 1 ? 's' : ''} (amber)` : ''}. <button class="btn small" data-act="ent-problems">${ui.onlyProblems ? 'Show all athletes' : 'Show only these'}</button> <button class="btn small" data-act="ent-issues">List problems</button>${fixable ? ` <button class="btn small primary" data-act="ent-autofix">Fix ${fixable} spelling difference${fixable > 1 ? 's' : ''}</button>` : ''}</div>`
      : warns.length ? `<div class="notice warn">${warns.length} warning${warns.length > 1 ? 's' : ''} (amber cells). <button class="btn small" data-act="ent-issues">List warnings</button></div>` : S.entries.length ? `<div class="notice">✓ All ${S.entries.length} entries check out.</div>` : ''}
      <div class="toolbar">
        <button class="btn primary" data-act="ent-paste">📋 Paste athletes…</button>
        <button class="btn" data-act="ent-file">Import file…</button>
        <button class="btn" data-act="ent-add">+ Add athlete</button>
        <span class="spacer"></span>
        <input type="search" id="ent-q" placeholder="Search name, club, number…" value="${esc(ui.q)}" style="width:220px">
        <select id="ent-cat"><option value="">All categories</option>${(() => { const n = S.entries.filter(e => !e.category || !d.catByName.has(e.category)).length; return n ? opt('__none__', `⚠ No / unknown category (${n})`, ui.fCat === '__none__') : ''; })()}${d.catOrder.filter(c => S.entries.some(e => e.category === c)).map(c => opt(c, `${c} (${S.entries.filter(e => e.category === c).length})`, ui.fCat === c)).join('')}</select>
        <select id="ent-team" style="max-width:200px"><option value="">All clubs</option>${teamsUsed.map(t => opt(t, t, ui.fTeam === t)).join('')}</select>
      </div>
      <div class="toolbar small">
        <span class="muted">${list.length} shown${list.length > MAX ? ` (first ${MAX})` : ''}${ui.sel.size ? ` · ${ui.sel.size} selected` : ''}</span>
        ${ui.sel.size ? `<button class="btn small" data-act="ent-bulk">Change selected…</button><button class="btn small danger" data-act="ent-delsel">Delete selected</button><button class="btn small" data-act="ent-clearsel">Clear selection</button>` : ''}
        <span class="spacer"></span>
        <button class="btn small" data-act="ent-renumber">Sort &amp; renumber…</button>
        <button class="btn small" data-act="ent-export">Export athletes</button>
      </div>
      ${S.entries.length ? `<div class="tbl-wrap"><table class="t" id="ent-table"><thead><tr><th class="c"><input type="checkbox" id="sel-all" title="Select all shown"></th>${th('id', 'No.')}${th('name', 'Name')}${th('category', 'Category')}${th('team', 'Club')}${showST ? '<th>Scoring team</th>' : ''}${regionCounty() ? '<th>County</th>' : ''}${regionProvince() ? '<th>Province</th>' : ''}${showDob ? '<th>DOB</th>' : ''}${showReg ? '<th>Reg #</th>' : ''}${showMasters ? '<th>Masters club team</th><th>Masters county team</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="card empty"><p style="font-size:16px">No athletes yet.</p><p>Open the entry list on the website, select the table (drag across it or press <kbd>Ctrl</kbd>+<kbd>A</kbd>), copy with <kbd>Ctrl</kbd>+<kbd>C</kbd>, then click <b>Paste athletes</b>.</p><button class="btn primary" data-act="ent-paste">📋 Paste athletes…</button></div>`}`;
  }
  function afterEntries() {
    const q = $('#ent-q');
    if (q) {
      q.oninput = () => { ui.q = q.value; const pos = q.selectionStart; render(); const q2 = $('#ent-q'); q2.focus(); q2.setSelectionRange(pos, pos); };
      $('#ent-cat').onchange = e => { ui.fCat = e.target.value; render(); };
      $('#ent-team').onchange = e => { ui.fTeam = e.target.value; render(); };
    }
    const all = $('#sel-all');
    if (all) all.onchange = () => { const list = filteredEntries(); if (all.checked) list.forEach(e => ui.sel.add(e.uid)); else list.forEach(e => ui.sel.delete(e.uid)); render(); };
    const t = $('#ent-table');
    if (t) t.addEventListener('click', e => {
      const th = e.target.closest('th[data-sort]'); if (th) { ui.sort = th.dataset.sort; render(); return; }
      const cb = e.target.closest('[data-sel]');
      if (cb) { cb.checked ? ui.sel.add(cb.dataset.sel) : ui.sel.delete(cb.dataset.sel); render(); return; }
      if (e.target.closest('[data-nosel]')) return;
      const tr = e.target.closest('tr[data-uid]'); if (tr) editAthlete(S.entries.find(x => x.uid === tr.dataset.uid));
    });
  }
  function editAthlete(e, preset) {
    const isNew = !e;
    const a = e ? { ...e } : Object.assign({ uid: uid(), id: S.settings.autoNumber ? nextId() : null, name: '', category: '', gender: '', dob: '', reg: '', team: '', scoringTeam: '', county: '', province: '', mastersTeam: '', mastersCountyTeam: '' }, preset || {});
    const issues = (derive().issuesByUid.get(a.uid) || []);
    const body = `${issues.length ? `<div class="notice err small">${issues.map(i => esc(i.msg)).join('<br>')}</div>` : ''}
      <div class="form-grid" style="grid-template-columns:1fr 1fr">
        <label class="f">Number<input type="number" name="id" value="${esc(a.id ?? '')}"></label>
        <label class="f">Name<input type="text" name="name" value="${esc(a.name)}" placeholder="First SURNAME"></label>
        <label class="f">Age category<select name="category">${catOptions(a.category)}</select></label>
        <label class="f">Date of birth<input type="date" name="dob" value="${esc(a.dob)}"></label>
        <label class="f" style="grid-column:1/-1">Club<input type="text" name="team" list="dl-teams" value="${esc(a.team)}" placeholder="Start typing a club…"></label>
        <label class="f" style="grid-column:1/-1">Scoring team <span class="muted" style="font-weight:400">(only if different from club, e.g. a school or guest)</span><input type="text" name="scoringTeam" list="dl-teams" value="${esc(a.scoringTeam)}" placeholder="Same as club"></label>
        <label class="f">County<select name="county">${listOptions(S.counties, a.county)}</select></label>
        <label class="f">Province<select name="province">${listOptions(S.provinces, a.province)}</select></label>
        <label class="f">Reg / licence #<input type="text" name="reg" value="${esc(a.reg)}"></label>
        <span></span>
        <label class="f">Masters club team<select name="mastersTeam">${listOptions(S.mastersTeamCategories, a.mastersTeam, 'None')}</select></label>
        <label class="f">Masters county team<select name="mastersCountyTeam">${listOptions(S.mastersTeamCategories, a.mastersCountyTeam, 'None')}</select></label>
      </div>${teamDatalist()}`;
    modal(isNew ? 'Add athlete' : 'Edit athlete', body, {
      footer: `${isNew ? '' : '<button class="btn danger" data-del>Delete</button><span class="spacer"></span>'}<button class="btn" data-cancel>Cancel</button>${isNew ? '<button class="btn" data-save-next>Save &amp; add another</button>' : ''}<button class="btn primary" data-save>Save</button>`,
      onMount: m => {
        const f = n => $(`[name=${n}]`, m.body);
        f(isNew && a.id ? 'name' : (isNew ? 'id' : 'name')).focus();
        f('team').addEventListener('change', () => {
          const t = derive().teamByName.get(f('team').value) || (derive().clubMatch(f('team').value) || {}).team;
          if (t) { f('team').value = t.name; if (t.county) f('county').innerHTML = listOptions(S.counties, t.county); if (t.province) f('province').innerHTML = listOptions(S.provinces, t.province); }
        });
        const save = () => {
          const v = n => f(n).value.trim();
          Object.assign(a, { id: v('id') === '' ? null : +v('id'), name: v('name'), category: v('category'), dob: v('dob'), team: v('team'), scoringTeam: v('scoringTeam') === v('team') ? '' : v('scoringTeam'), county: v('county'), province: v('province'), reg: v('reg'), mastersTeam: v('mastersTeam'), mastersCountyTeam: v('mastersCountyTeam') });
          const cat = derive().catByName.get(a.category); if (cat) a.gender = cat.gender;
          if (!a.name) { toast('Enter a name', true); return false; }
          if (isNew) S.entries.push(a); else Object.assign(e, a);
          return true;
        };
        $('[data-cancel]', m.el).onclick = m.close;
        $('[data-save]', m.el).onclick = () => { if (save()) { m.close(); commit(); } };
        const sn = $('[data-save-next]', m.el);
        if (sn) sn.onclick = () => { if (save()) { const keep = { category: a.category, team: a.team, county: a.county, province: a.province }; m.close(); commit(); editAthlete(null, keep); } };
        const del = $('[data-del]', m.el);
        if (del) del.onclick = () => { if (confirm(`Delete ${e.name}?`)) { S.entries = S.entries.filter(x => x !== e); m.close(); commit(); } };
        m.body.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); (sn || $('[data-save]', m.el)).click(); } });
      },
    });
  }
  /** Unknown club / county / province / category values that only differ in case, punctuation or spacing. */
  function autoFixes() {
    const d = derive(); const fixes = [];
    const simple = v => X.lc(v).replace(/[^a-z0-9]+/gi, '');
    const lookup = list => { const m = new Map(); for (const x of list) m.set(simple(x), x); return m; };
    const teams = lookup(S.teams.map(t => t.name)), counties = lookup(S.counties), provs = lookup(S.provinces), cats = lookup(S.ageCategories.map(c => c.name));
    for (const i of d.issues) {
      if (i.level !== 'error') continue;
      const e = S.entries.find(x => x.uid === i.uid); if (!e) continue;
      const v = e[i.field]; let to = null;
      if (i.field === 'team' || i.field === 'scoringTeam') { to = teams.get(simple(v)); if (!to) { const m = d.clubMatch(v); if (m && m.score >= 0.97) to = m.team.name; } }
      else if (i.field === 'county') to = counties.get(simple(v));
      else if (i.field === 'province') to = provs.get(simple(v));
      else if (i.field === 'category') to = cats.get(simple(v));
      if (to && to !== v) fixes.push({ e, field: i.field, from: v, to });
    }
    return fixes;
  }
  function bulkEdit() {
    const body = `<p class="small muted">Only the fields you fill in are changed for the ${ui.sel.size} selected athletes.</p>
      <div class="form-grid" style="grid-template-columns:1fr 1fr">
      <label class="f">Age category<select name="category">${catOptions('', { blankLabel: '(no change)' })}</select></label>
      <label class="f">Club<input type="text" name="team" list="dl-teams" placeholder="(no change)"></label>
      <label class="f">County<select name="county">${listOptions(S.counties, '', '(no change)')}</select></label>
      <label class="f">Province<select name="province">${listOptions(S.provinces, '', '(no change)')}</select></label>
      <label class="f">Masters club team<select name="mastersTeam">${opt('', '(no change)')}${opt('-', 'None')}${S.mastersTeamCategories.map(x => opt(x)).join('')}</select></label>
      <label class="f">Masters county team<select name="mastersCountyTeam">${opt('', '(no change)')}${opt('-', 'None')}${S.mastersTeamCategories.map(x => opt(x)).join('')}</select></label>
      </div>${teamDatalist()}`;
    modal('Change selected athletes', body, {
      footer: '<button class="btn" data-c>Cancel</button><button class="btn primary" data-ok>Apply</button>', onMount: m => {
        $('[data-c]', m.el).onclick = m.close;
        $('[data-ok]', m.el).onclick = () => {
          const v = n => $(`[name=${n}]`, m.body).value.trim();
          const t = v('team') && (derive().teamByName.get(v('team')) || (derive().clubMatch(v('team')) || {}).team);
          for (const e of S.entries) if (ui.sel.has(e.uid)) {
            if (v('category')) e.category = v('category');
            if (v('team')) { e.team = t ? t.name : v('team'); if (t && !v('county')) e.county = t.county; if (t && !v('province')) e.province = t.province; }
            if (v('county')) e.county = v('county');
            if (v('province')) e.province = v('province');
            if (v('mastersTeam')) e.mastersTeam = v('mastersTeam') === '-' ? '' : v('mastersTeam');
            if (v('mastersCountyTeam')) e.mastersCountyTeam = v('mastersCountyTeam') === '-' ? '' : v('mastersCountyTeam');
          }
          m.close(); commit(); toast('Updated ' + ui.sel.size + ' athletes');
        };
      },
    });
  }
  function showIssues() {
    const d = derive();
    const byUid = new Map(S.entries.map(e => [e.uid, e]));
    const body = `<table class="t"><thead><tr><th>No.</th><th>Athlete</th><th>Problem</th></tr></thead><tbody>${d.issues.map(i => { const e = byUid.get(i.uid); return `<tr class="clickable ${i.level === 'error' ? 'err' : 'warn'}" data-uid="${i.uid}"><td>${esc(e.id ?? '')}</td><td>${esc(e.name)}</td><td>${esc(i.msg)}</td></tr>`; }).join('')}</tbody></table>`;
    modal(`${d.issues.length} problems`, body, {
      wide: true, onMount: m => m.body.addEventListener('click', ev => { const tr = ev.target.closest('tr[data-uid]'); if (tr) { m.close(); editAthlete(byUid.get(tr.dataset.uid)); } }),
    });
  }
  function renumber() {
    const hasRes = Object.values(S.results).some(r => r.length);
    const body = `${hasRes ? '<div class="notice err">Results have already been entered. Renumbering now would change bib numbers and break those results — clear results first.</div>' : ''}
      <p>Sort all athletes, then give them new numbers starting from <b>${esc(S.settings.startId)}</b> (set on the Competition tab).</p>
      <label class="f">Sort by<select id="rn-sort">${opt('category', 'Race order → club → surname', true)}${opt('catname', 'Race order → surname')}${opt('team', 'Club → surname')}${opt('name', 'Surname')}</select></label>
      <label class="chk" style="margin-top:10px"><input type="checkbox" id="rn-gap"> Start each race at a round number (e.g. 1, 201, 401…)</label>`;
    modal('Sort & renumber athletes', body, {
      footer: `<button class="btn" data-c>Cancel</button><button class="btn primary" data-ok ${hasRes ? 'disabled' : ''}>Renumber</button>`, onMount: m => {
        $('[data-c]', m.el).onclick = m.close;
        $('[data-ok]', m.el).onclick = () => {
          const d = derive(); const ci = new Map(d.catOrder.map((c, i) => [c, i]));
          const evIdx = e => { const ev = d.eventOfCat.get(e.category); return ev ? S.program.indexOf(ev) : 999; };
          const mode = $('#rn-sort').value;
          const cmp = {
            category: (a, b) => evIdx(a) - evIdx(b) || (ci.get(a.category) ?? 999) - (ci.get(b.category) ?? 999) || a.team.localeCompare(b.team) || surnameKey(a.name).localeCompare(surnameKey(b.name)),
            catname: (a, b) => evIdx(a) - evIdx(b) || surnameKey(a.name).localeCompare(surnameKey(b.name)),
            team: (a, b) => a.team.localeCompare(b.team) || surnameKey(a.name).localeCompare(surnameKey(b.name)),
            name: (a, b) => surnameKey(a.name).localeCompare(surnameKey(b.name)),
          }[mode];
          S.entries.sort(cmp);
          let n = +S.settings.startId || 1, lastEv = null;
          const gap = $('#rn-gap').checked;
          for (const e of S.entries) {
            const ev = evIdx(e);
            if (gap && lastEv !== null && ev !== lastEv && (mode === 'category' || mode === 'catname')) n = Math.ceil((n - 1) / 100) * 100 + 1;
            e.id = n++; lastEv = ev;
          }
          m.close(); ui.sort = 'id'; commit(); toast('Renumbered ' + S.entries.length + ' athletes');
        };
      },
    });
  }
  function entriesSheet() {
    const rows = [['No.', 'Name', 'Age Category', 'DOB', 'Reg #', 'Club', 'Scoring Team', 'County', 'Province', 'Masters Club Team', 'Masters County Team']];
    for (const e of [...S.entries].sort((a, b) => (a.id ?? 1e9) - (b.id ?? 1e9))) rows.push([e.id ?? '', e.name, e.category, e.dob, e.reg, e.team, e.scoringTeam || e.team, e.county, e.province, e.mastersTeam, e.mastersCountyTeam]);
    return { name: 'Entries', rows, bold: new Set([0]), widths: [7, 28, 18, 11, 10, 30, 30, 12, 12, 16, 16] };
  }

  // ---------------------------------------------------------------- paste import
  function importDialog(initialRows, sourceLabel) {
    const st = {
      rows: initialRows || null, mapping: [], headerIndex: -1, source: sourceLabel || '',
      defaultCategory: '', defaultTeam: '', detectFromDob: true, skipExisting: true, useIds: true,
      upperSurname: S.settings.upperSurname !== false, clubFix: {}, catFix: {},
    };
    const m = modal('Paste athletes', '', { wide: true, footer: '<span id="imp-summary" class="small muted"></span><span class="spacer"></span><button class="btn" data-c>Cancel</button><button class="btn primary" id="imp-go" disabled>Import</button>' });
    $('[data-c]', m.el).onclick = m.close;
    const setRows = (rows, label) => {
      rows = rows.map(r => r.map(c => typeof c === 'number' ? c : X.norm(c)));
      while (rows.length && !rows[rows.length - 1].some(c => c !== '')) rows.pop();
      if (!rows.length) { toast('Nothing found to import', true); return; }
      const d = derive();
      st.rows = rows; st.source = label || st.source;
      const det = X.detectColumns(rows.map(r => r.map(String)), { clubMatch: d.clubMatch, catMatch: d.catMatch });
      st.mapping = det.mapping; st.headerIndex = det.headerIndex;
      draw();
    };
    st.setRows = setRows;
    const pasteHandler = ev => {
      const html = ev.clipboardData.getData('text/html');
      const text = ev.clipboardData.getData('text/plain');
      ev.preventDefault();
      let rows = null;
      if (html) { try { rows = X.parseHtmlTables(html); } catch (e) { rows = null; } }
      if (!rows || rows.filter(r => r.length > 1).length < 1) rows = X.parseDelimited(text);
      setRows(rows, 'Pasted');
    };
    function draw() {
      const d = derive();
      if (!st.rows) {
        m.body.innerHTML = `
          <div class="grid g2" style="grid-template-columns:2fr 1fr">
            <div><textarea class="paste-zone" id="imp-zone" placeholder="Click here and press Ctrl+V to paste…"></textarea>
              <div class="row" style="margin-top:8px"><button class="btn" id="imp-clip">Paste from clipboard</button><button class="btn" id="imp-file">…or choose a file (.xlsx, .csv)</button><button class="btn" id="imp-parse">Use typed text</button></div></div>
            <div class="small" style="line-height:1.6">
              <b>How to copy from a website</b>
              <ol style="padding-left:18px;margin:6px 0">
                <li>Open the entry list page.</li>
                <li>Drag across the table to select it, or press <kbd>Ctrl</kbd>+<kbd>A</kbd> to select the whole page.</li>
                <li>Press <kbd>Ctrl</kbd>+<kbd>C</kbd>, click the box, and press <kbd>Ctrl</kbd>+<kbd>V</kbd>.</li>
              </ol>
              <p class="muted">Works with tables from websites, Excel, Google Sheets, CSV, or one athlete per line. Headings like “U12 Girls” or a club name above a group of athletes are recognised.</p>
            </div>
          </div>`;
        const z = $('#imp-zone', m.body);
        z.focus();
        z.addEventListener('paste', pasteHandler);
        $('#imp-parse', m.body).onclick = () => z.value.trim() && setRows(X.parseDelimited(z.value), 'Typed');
        $('#imp-file', m.body).onclick = () => pickImportFile(setRows);
        $('#imp-clip', m.body).onclick = async () => {
          try {
            if (navigator.clipboard.read) {
              const items = await navigator.clipboard.read();
              for (const it of items) {
                if (it.types.includes('text/html')) { const rows = X.parseHtmlTables(await (await it.getType('text/html')).text()); if (rows && rows.length) { setRows(rows, 'Clipboard'); return; } }
              }
            }
            const t = await navigator.clipboard.readText(); if (t.trim()) setRows(X.parseDelimited(t), 'Clipboard'); else toast('Clipboard is empty', true);
          } catch (e) { toast('Browser blocked clipboard access — click in the box and press Ctrl+V instead', true); z.focus(); }
        };
        $('#imp-go', m.el).disabled = true; $('#imp-summary', m.el).textContent = '';
        return;
      }
      const recs = X.rowsToRecords(st.rows.map(r => r.map((c, j) => typeof c === 'number' && st.mapping[j] !== 'dob' ? String(c) : c)), {
        mapping: st.mapping, headerIndex: st.headerIndex, upperSurname: st.upperSurname, defaultCategory: st.defaultCategory, defaultTeam: st.defaultTeam,
        detectFromDob: st.detectFromDob, year: +S.settings.year || new Date().getFullYear(), programCats: d.progCats,
        clubMatch: d.clubMatch, catMatch: d.catMatch, cats: S.ageCategories,
      });
      // resolve clubs & categories
      const unknownClubs = new Map(), unknownCats = new Map();
      for (const r of recs) {
        const rec = r.rec;
        rec.team = ''; rec.teamNote = '';
        if (rec.teamText) {
          const fix = st.clubFix[rec.teamText];
          if (fix) { rec.team = fix.action === 'map' ? fix.name : fix.action === 'new' ? rec.teamText : ''; rec.teamNote = fix.action; }
          else {
            const mt = d.clubMatch(rec.teamText);
            if (mt && (mt.exact || mt.score >= 0.9)) { rec.team = mt.team.name; rec.teamNote = mt.exact ? '' : 'auto'; }
            else { if (!unknownClubs.has(rec.teamText)) unknownClubs.set(rec.teamText, { n: 0, best: mt }); unknownClubs.get(rec.teamText).n++; }
          }
        }
        if (!rec.category && rec.categoryText) {
          const fix = st.catFix[rec.categoryText];
          if (fix) rec.category = fix;
          else { if (!unknownCats.has(rec.categoryText)) unknownCats.set(rec.categoryText, 0); unknownCats.set(rec.categoryText, unknownCats.get(rec.categoryText) + 1); }
        }
        const t = d.teamByName.get(rec.team);
        rec.countyOut = rec.county ? (S.counties.find(c => X.lc(c) === X.lc(rec.county)) || rec.county) : (t ? t.county : (st.clubFix[rec.teamText] || {}).county || '');
        rec.provinceOut = rec.province ? (S.provinces.find(c => X.lc(c) === X.lc(rec.province)) || rec.province) : (t ? t.province : (st.clubFix[rec.teamText] || {}).province || '');
        if (rec.scoringTeamText) { const mt = d.clubMatch(rec.scoringTeamText); rec.scoringTeam = mt && mt.score >= 0.9 ? mt.team.name : rec.scoringTeamText; }
        const exist = S.entries.find(e => X.lc(e.name) === X.lc(rec.name) && (!rec.category || e.category === rec.category));
        rec.exists = !!exist;
        rec.problems = [];
        if (!rec.category) rec.problems.push('no category');
        if (rec.teamText && !rec.team) rec.problems.push('club not matched');
      }
      st.recs = recs;
      const toImport = recs.filter(r => !(st.skipExisting && r.rec.exists));
      const hasId = st.mapping.includes('id');
      const mapHead = st.mapping.map((f, j) => `<th><select data-col="${j}">${X.FIELDS.map(([k, l]) => opt(k, l, f === k)).join('')}</select></th>`).join('');
      const preview = st.rows.slice(0, 8).map((r, i) => `<tr style="${i === st.headerIndex ? 'opacity:.5;text-decoration:line-through' : ''}">${st.mapping.map((_, j) => `<td title="${esc(r[j])}">${esc(r[j] ?? '')}</td>`).join('')}</tr>`).join('');
      const bestFor = (txt, info) => info.best ? info.best.team.name : '';
      m.body.innerHTML = `
        <div class="row" style="margin-bottom:10px"><b>${esc(st.source)}:</b> <span class="muted">${st.rows.length} rows · ${recs.length} athletes found</span><span class="spacer"></span><button class="btn small" id="imp-again">↺ Paste something else</button></div>
        <h3 style="margin-top:0">1. Check the columns</h3>
        <p class="small muted" style="margin-top:-4px">Change a heading if a column was guessed wrong. ${st.headerIndex >= 0 ? 'The crossed-out row was read as the header.' : 'No header row was found — columns were guessed from their contents.'}</p>
        <div class="tbl-wrap" style="max-height:260px"><table class="t map-table"><thead><tr>${mapHead}</tr></thead><tbody>${preview}</tbody></table></div>
        <h3>2. Options</h3>
        <div class="form-grid">
          <label class="f">Age category for athletes without one<select id="imp-defcat">${catOptions(st.defaultCategory, { blankLabel: '— none —' })}</select></label>
          <label class="f">Club for athletes without one<input type="text" id="imp-defteam" list="dl-teams" value="${esc(st.defaultTeam)}" placeholder="— none —"></label>
          <div style="display:flex;flex-direction:column;gap:5px;padding-top:4px" class="small">
            <label class="chk"><input type="checkbox" id="imp-dob" ${st.detectFromDob ? 'checked' : ''}> Work out category from date of birth + gender</label>
            <label class="chk"><input type="checkbox" id="imp-upper" ${st.upperSurname ? 'checked' : ''}> Names as “First SURNAME”</label>
          </div>
          <div style="display:flex;flex-direction:column;gap:5px;padding-top:4px" class="small">
            <label class="chk"><input type="checkbox" id="imp-skip" ${st.skipExisting ? 'checked' : ''}> Skip athletes already entered</label>
            ${hasId ? `<label class="chk"><input type="checkbox" id="imp-ids" ${st.useIds ? 'checked' : ''}> Keep numbers from the pasted list</label>` : ''}
          </div>
        </div>
        ${(() => { const n = toImport.filter(r => !r.rec.category).length; return n ? `<div class="notice err" style="margin-top:12px"><b>${n} athlete${n > 1 ? 's have' : ' has'} no age category yet</b>, so ${n > 1 ? 'they' : 'it'} won't appear under any race. ${unknownCats.size ? 'Pick the right category for each value below' : 'Choose a category column above, or set “Age category for athletes without one”'} — or fix ${n > 1 ? 'them' : 'it'} after importing with the “No / unknown category” filter on the Athletes tab.</div>` : ''; })()}
        ${unknownClubs.size || unknownCats.size ? `<h3>3. Confirm unrecognised values</h3>
        <div class="notice warn small">These didn't match the club / category lists exactly. Pick the right one — your choices are remembered for next time.</div>
        <div class="fix-list">
          ${[...unknownCats.entries()].map(([txt, n]) => `<div><span class="pill warn">category</span> <b>${esc(txt)}</b> <span class="muted small">×${n}</span></div><div class="arrow">→</div><select data-catfix="${esc(txt)}">${catOptions('', { blankLabel: '— pick a category —' })}</select><span></span>`).join('')}
          ${[...unknownClubs.entries()].map(([txt, info]) => `<div><span class="pill warn">club</span> <b>${esc(txt)}</b> <span class="muted small">×${info.n}</span></div><div class="arrow">→</div>
            <input type="text" list="dl-teams" data-clubfix="${esc(txt)}" value="${esc(bestFor(txt, info))}" placeholder="Type to pick a club">
            <span class="row" style="gap:4px"><button class="btn small" data-clubok="${esc(txt)}">Use this</button><button class="btn small" data-clubnew="${esc(txt)}" title="Add “${esc(txt)}” to the club list">Add as new club</button><button class="btn small" data-clubblank="${esc(txt)}">No club</button></span>`).join('')}
        </div>` : ''}
        <h3>${unknownClubs.size || unknownCats.size ? '4' : '3'}. Preview</h3>
        <div class="tbl-wrap" style="max-height:330px"><table class="t"><thead><tr><th>No.</th><th>Name</th><th>Category</th><th>Club</th>${regionCounty() ? '<th>County</th>' : ''}<th>DOB</th><th>Status</th></tr></thead><tbody>
          ${recs.slice(0, 400).map(r => { const x = r.rec; const skip = st.skipExisting && x.exists; return `<tr class="${skip ? '' : x.problems.length ? 'warn' : ''}" style="${skip ? 'opacity:.45' : ''}"><td>${esc(hasId && st.useIds ? x.id ?? '' : '')}</td><td>${esc(x.name)}</td><td>${esc(x.category || (x.categoryText ? '? ' + x.categoryText : ''))}${x.catSource === 'dob' ? ' <span class="pill small" title="From date of birth">DOB</span>' : ''}</td><td>${esc(x.team || (x.teamText ? '? ' + x.teamText : ''))}${x.teamNote === 'auto' ? ` <span class="pill ok" title="Matched from “${esc(x.teamText)}”">matched</span>` : ''}</td>${regionCounty() ? `<td>${esc(x.countyOut)}</td>` : ''}<td>${esc(x.dob)}</td><td>${skip ? '<span class="pill">already entered</span>' : x.problems.map(p => `<span class="pill warn">${p}</span>`).join('') || '<span class="pill ok">ok</span>'}</td></tr>`; }).join('')}
          ${recs.length > 400 ? `<tr><td colspan="7" class="muted">…and ${recs.length - 400} more</td></tr>` : ''}
        </tbody></table></div>${teamDatalist()}`;
      const go = $('#imp-go', m.el);
      go.disabled = !toImport.length;
      go.textContent = `Import ${toImport.length} athlete${toImport.length === 1 ? '' : 's'}`;
      const probs = toImport.filter(r => r.rec.problems.length).length;
      const noCat = toImport.filter(r => !r.rec.category).length;
      $('#imp-summary', m.el).innerHTML = noCat ? `<span style="color:var(--err)">${noCat} without an age category</span>${probs > noCat ? ` · ${probs - noCat} other${probs - noCat > 1 ? 's' : ''} to check` : ''}` : probs ? `${probs} will need fixing after import (shown in amber).` : '';
      // wire
      $('#imp-again', m.body).onclick = () => { st.rows = null; draw(); };
      $$('[data-col]', m.body).forEach(s => s.onchange = () => {
        const j = +s.dataset.col; const v = s.value;
        if (v !== 'ignore') st.mapping = st.mapping.map((x, k) => (x === v && k !== j ? 'ignore' : x));
        st.mapping[j] = v;
        if (st.headerIndex < 0 && v !== 'ignore' && X.headerField(st.rows[0][j]) === v) st.headerIndex = 0;
        draw();
      });
      $('#imp-defcat', m.body).onchange = e => { st.defaultCategory = e.target.value; draw(); };
      $('#imp-defteam', m.body).onchange = e => { const mt = d.clubMatch(e.target.value); st.defaultTeam = mt && mt.score > 0.85 ? mt.team.name : e.target.value; draw(); };
      $('#imp-dob', m.body).onchange = e => { st.detectFromDob = e.target.checked; draw(); };
      $('#imp-upper', m.body).onchange = e => { st.upperSurname = e.target.checked; draw(); };
      $('#imp-skip', m.body).onchange = e => { st.skipExisting = e.target.checked; draw(); };
      const ids = $('#imp-ids', m.body); if (ids) ids.onchange = e => { st.useIds = e.target.checked; draw(); };
      $$('[data-catfix]', m.body).forEach(s => s.onchange = () => { if (s.value) { st.catFix[s.dataset.catfix] = s.value; draw(); } });
      $$('[data-clubok]', m.body).forEach(b => b.onclick = () => {
        const txt = b.dataset.clubok; const inp = $$('[data-clubfix]', m.body).find(i => i.dataset.clubfix === txt);
        const t = d.teamByName.get(inp.value) || ((d.clubMatch(inp.value) || {}).score > 0.85 ? d.clubMatch(inp.value).team : null);
        if (!t) { toast('Pick a club from the list, or use “Add as new club”', true); inp.focus(); return; }
        st.clubFix[txt] = { action: 'map', name: t.name }; draw();
      });
      $$('[data-clubfix]', m.body).forEach(inp => inp.addEventListener('keydown', e => { if (e.key === 'Enter') $$('[data-clubok]', m.body).find(b => b.dataset.clubok === inp.dataset.clubfix).click(); }));
      $$('[data-clubnew]', m.body).forEach(b => b.onclick = () => newClubDialog(b.dataset.clubnew, (name, county, province) => { st.clubFix[b.dataset.clubnew] = { action: 'new', name, county, province }; draw(); }));
      $$('[data-clubblank]', m.body).forEach(b => b.onclick = () => { st.clubFix[b.dataset.clubblank] = { action: 'blank' }; draw(); });
    }
    $('#imp-go', m.el).onclick = () => {
      const recs = st.recs.filter(r => !(st.skipExisting && r.rec.exists));
      const used = new Set(S.entries.map(e => String(e.id)));
      // new clubs & learnt aliases
      for (const [txt, fix] of Object.entries(st.clubFix)) {
        if (fix.action === 'new' && !S.teams.some(t => t.name === fix.name)) { S.teams.push({ name: fix.name, code: '', county: fix.county || '', province: fix.province || '' }); S.teams.sort((a, b) => a.name.localeCompare(b.name)); }
        if (fix.action === 'map' || fix.action === 'new') S.aliases[txt] = fix.name;
      }
      let added = 0;
      const pending = [];
      for (const { rec } of recs) {
        let id = null;
        if (st.useIds && rec.id != null && !used.has(String(rec.id))) id = rec.id;
        const team = rec.team || (st.clubFix[rec.teamText] || {}).name || '';
        const tObj = S.teams.find(t => t.name === team);
        const e = { uid: uid(), id, name: rec.name, category: rec.category || '', gender: rec.gender || (derive().catByName.get(rec.category) || {}).gender || '', dob: rec.dob, reg: rec.reg, team, scoringTeam: rec.scoringTeam && rec.scoringTeam !== team ? rec.scoringTeam : '', county: rec.countyOut || (tObj ? tObj.county : ''), province: rec.provinceOut || (tObj ? tObj.province : ''), mastersTeam: X.lc(rec.mastersTeam) ? S.mastersTeamCategories.find(x => X.lc(x) === X.lc(rec.mastersTeam)) || rec.mastersTeam : '', mastersCountyTeam: X.lc(rec.mastersCountyTeam) ? S.mastersTeamCategories.find(x => X.lc(x) === X.lc(rec.mastersCountyTeam)) || rec.mastersCountyTeam : '' };
        if (id != null) used.add(String(id));
        pending.push(e); added++;
      }
      if (S.settings.autoNumber) { for (const e of pending) if (e.id == null) { e.id = nextId([...used].map(Number).filter(n => !isNaN(n))); used.add(String(e.id)); } }
      S.entries.push(...pending);
      m.close(); ui.tab = 'entries'; ui.sel.clear(); commit();
      toast(`Imported ${added} athletes` + (recs.length - added ? ` (${recs.length - added} skipped)` : ''));
    };
    if (initialRows) setRows(initialRows, sourceLabel); else draw();
    return st;
  }
  function newClubDialog(name, done) {
    const body = `<div class="form-grid" style="grid-template-columns:1fr 1fr"><label class="f" style="grid-column:1/-1">Club name<input type="text" name="n" value="${esc(name)}"></label>
      <label class="f">County<select name="c">${listOptions(S.counties, '')}</select></label><label class="f">Province<select name="p">${listOptions(S.provinces, S.settings.region && S.provinces.includes(S.settings.region) ? S.settings.region : '')}</select></label></div>`;
    modal('Add a new club', body, {
      footer: '<button class="btn" data-c>Cancel</button><button class="btn primary" data-ok>Add club</button>', onMount: m => {
        $('[data-c]', m.el).onclick = m.close;
        $('[data-ok]', m.el).onclick = () => { const v = n => $(`[name=${n}]`, m.body).value.trim(); if (!v('n')) return; done(v('n'), v('c'), v('p')); m.close(); };
      },
    });
  }
  function pickImportFile(cb) {
    const inp = $('#file-import');
    inp.value = '';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        if (/\.(xlsx|xlsm)$/i.test(f.name)) {
          const sheets = await X.readXlsx(await f.arrayBuffer());
          if (X.isMeetWorkbook(sheets) && confirm(`${f.name} looks like a complete meet workbook (it has Program and Entries sheets).\n\nOK — import it as a NEW meet, with its races, athletes and results.\nCancel — just add its athletes to this meet.`)) { workbookDialog(sheets, f.name); return; }
          if (X.isMeetWorkbook(sheets)) { const en = sheets.find(sh => sh.name.toLowerCase() === 'entries'); cb(en.rows, f.name + ' — Entries'); return; }
          const rows = [];
          for (const sh of sheets) {
            if (!sh.rows.some(r => r.some(c => c !== ''))) continue;
            if (sheets.length > 1) rows.push([sh.name]);
            rows.push(...sh.rows);
          }
          cb(rows, f.name);
        } else if (/\.html?$/i.test(f.name)) cb(X.parseHtmlTables(await f.text()) || [], f.name);
        else cb(X.parseDelimited(await f.text()), f.name);
      } catch (e) { toast('Could not read ' + f.name + ': ' + e.message, true); }
    };
    inp.click();
  }

  // ================================================================ 4. lists
  function bookletReport() {
    let h = header() + '<h2 style="border:0;margin:6px 0 12px">Competitors</h2>';
    for (const ev of S.program) {
      const list = entriesFor(ev);
      if (!list.length) continue;
      const ci = new Map(ev.categories.map((c, i) => [c, i]));
      list.sort((a, b) => ci.get(a.category) - ci.get(b.category) || (a.id ?? 1e9) - (b.id ?? 1e9));
      h += `<h2>Event ${esc(ev.number)} · ${esc(ev.distance)} ${esc(ev.categories.join(' / '))}${ev.time ? ` <span style="font-weight:400">— ${esc(ev.time)}</span>` : ''}</h2>
        <table><thead><tr><th style="width:60px">No.</th><th>Name</th><th>Club</th>${ev.categories.length > 1 ? '<th>Category</th>' : ''}</tr></thead><tbody>
        ${list.map(e => `<tr><td>${esc(e.id ?? '')}</td><td>${esc(e.name)}</td><td>${esc(e.team)}</td>${ev.categories.length > 1 ? `<td>${esc(e.category)}</td>` : ''}</tr>`).join('')}</tbody></table>`;
    }
    return h;
  }
  function bookletSheet() {
    const rows = [], bold = new Set();
    for (const ev of S.program) {
      const list = entriesFor(ev); if (!list.length) continue;
      bold.add(rows.length); rows.push([{ v: `Event ${ev.number} ${ev.distance} ${ev.categories.join('/')}`, h: true }]);
      bold.add(rows.length); rows.push(['No.', 'Name', 'Club', 'Age Category']);
      list.sort((a, b) => (a.id ?? 1e9) - (b.id ?? 1e9)).forEach(e => rows.push([e.id ?? '', e.name, e.team, e.category]));
      rows.push([]);
    }
    return { name: 'Booklet', rows, bold, widths: [8, 30, 32, 18] };
  }
  function clubGroups() {
    const d = derive(); const ci = new Map(d.catOrder.map((c, i) => [c, i]));
    const groups = new Map();
    for (const e of S.entries) { const k = e.team || '(no club)'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
    const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    sorted.forEach(([, l]) => l.sort((a, b) => (ci.get(a.category) ?? 999) - (ci.get(b.category) ?? 999) || (a.id ?? 1e9) - (b.id ?? 1e9)));
    return sorted;
  }
  function clubListReport() {
    const d = derive();
    return clubGroups().map(([club, list], i, arr) => `<div class="${i < arr.length - 1 ? 'page-break' : ''}">${header()}<h2>${esc(club)} <span style="font-weight:400">— ${list.length} athlete${list.length > 1 ? 's' : ''}</span></h2>
      <table><thead><tr><th style="width:60px">No.</th><th>Name</th><th>Age category</th><th>Race</th></tr></thead><tbody>
      ${list.map(e => { const ev = d.eventOfCat.get(e.category); return `<tr><td>${esc(e.id ?? '')}</td><td>${esc(e.name)}</td><td>${esc(e.category)}</td><td>${ev ? `Event ${esc(ev.number)} · ${esc(ev.distance)}${ev.time ? ' · ' + esc(ev.time) : ''}` : '<i>not on program</i>'}</td></tr>`; }).join('')}
      </tbody></table></div>`).join('');
  }
  function clubListSheet() {
    const d = derive(); const rows = [], bold = new Set();
    for (const [club, list] of clubGroups()) {
      bold.add(rows.length); rows.push([{ v: club, h: true }]);
      bold.add(rows.length); rows.push(['No.', 'Name', 'Age Category', 'Race']);
      list.forEach(e => { const ev = d.eventOfCat.get(e.category); rows.push([e.id ?? '', e.name, e.category, ev ? `Event ${ev.number} ${ev.distance}` : '']); });
      rows.push(['', '', 'Total', list.length]); rows.push([]);
    }
    return { name: 'Club Lists', rows, bold, widths: [8, 30, 20, 22] };
  }
  function checkInReport() {
    const extra = Math.max(0, +S.settings.checkInExtraRows || 0);
    const evs = S.program.filter(ev => entriesFor(ev).length);
    return evs.map((ev, i) => {
      const list = entriesFor(ev).sort((a, b) => (a.id ?? 1e9) - (b.id ?? 1e9));
      const multi = ev.categories.length > 1;
      return `<div class="${i < evs.length - 1 ? 'page-break' : ''}">${header()}<h2>Check-in · Event ${esc(ev.number)} · ${esc(ev.distance)} ${esc(ev.categories.join(' / '))}</h2>
      <table class="boxed"><thead><tr><th style="width:30px">✓</th><th style="width:60px">No.</th><th>Name</th><th>Club</th>${multi ? '<th>Category</th>' : ''}<th style="width:25%">Notes</th></tr></thead><tbody>
      ${list.map(e => `<tr><td><span class="checkbox"></span></td><td>${esc(e.id ?? '')}</td><td>${esc(e.name)}</td><td>${esc(e.team)}</td>${multi ? `<td>${esc(e.category)}</td>` : ''}<td></td></tr>`).join('')}
      ${Array.from({ length: extra }, () => `<tr><td><span class="checkbox"></span></td><td>&nbsp;</td><td></td><td></td>${multi ? '<td></td>' : ''}<td></td></tr>`).join('')}
      </tbody></table><p class="small">${list.length} entered</p></div>`;
    }).join('');
  }
  function checkInSheet() {
    const rows = [], bold = new Set();
    for (const ev of S.program) {
      const list = entriesFor(ev); if (!list.length) continue;
      bold.add(rows.length); rows.push([{ v: `Event ${ev.number} ${ev.distance} ${ev.categories.join('/')}`, h: true }]);
      bold.add(rows.length); rows.push(['✓', 'No.', 'Name', 'Club', 'Age Category', 'Notes']);
      list.sort((a, b) => (a.id ?? 1e9) - (b.id ?? 1e9)).forEach(e => rows.push(['', e.id ?? '', e.name, e.team, e.category, '']));
      for (let k = 0; k < (+S.settings.checkInExtraRows || 0); k++) rows.push([]);
      rows.push([]);
    }
    return { name: 'Check In', rows, bold, widths: [4, 8, 30, 32, 18, 24] };
  }
  function viewLists() {
    const tabs = { booklet: ['Booklet', bookletReport, bookletSheet], clubs: ['Club lists', clubListReport, clubListSheet], checkin: ['Check-in sheets', checkInReport, checkInSheet], program: ['Program', programReport, null] };
    const [label, rep] = tabs[ui.listTab];
    const html = S.entries.length || ui.listTab === 'program' ? rep() : '<div class="empty">Add athletes first.</div>';
    return `<h2>Lists &amp; booklet</h2><p class="sub">Printable lists, built from the program and athletes. They update automatically.</p>
      <div class="toolbar"><div class="subtabs" style="margin:0">${Object.entries(tabs).map(([k, [l]]) => `<button data-act="list-tab" data-k="${k}" class="${ui.listTab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <span class="spacer"></span><button class="btn primary" data-act="list-print">🖨 Print ${esc(label.toLowerCase())}</button>${tabs[ui.listTab][2] ? '<button class="btn" data-act="list-xlsx">Excel</button><button class="btn" data-act="list-csv">CSV</button>' : ''}</div>
      <div class="report" id="list-report">${html}</div>`;
  }

  // ================================================================ 5. results
  function currentEvent() {
    if (!S.program.length) return null;
    let ev = S.program.find(p => String(p.number) === String(ui.evt));
    if (!ev) { ev = S.program[0]; ui.evt = ev.number; }
    return ev;
  }
  const resultsOf = ev => (S.results[ev.number] = S.results[ev.number] || []);
  function teamTable(teams, label, opts = {}) {
    if (!teams.length) return '';
    return `<div class="score-block"><h4>${esc(label)}</h4><table class="t"><thead><tr><th class="num" style="width:40px">Place</th><th>${opts.col || 'Team'}</th><th>Positions</th><th class="num">Points</th></tr></thead><tbody>
      ${teams.map(t => `<tr><td class="num">${t.place}${t.tie ? '=' : ''}</td><td>${esc(t.name)}</td><td class="small">${t.positions.join(', ')}</td><td class="num"><b>${t.points}</b></td></tr>`).join('')}</tbody></table></div>`;
  }
  function scoresHtml(ev, sc, forPrint) {
    let h = '';
    const multi = sc.groups.length > 1 || ev.categories.length > 1;
    for (const g of sc.groups) {
      if (multi) {
        h += `<div class="score-block"><h4>${esc(g.category)} — individual <span class="pill">${g.results.length}</span></h4>${g.results.length ? `<table class="t"><thead><tr><th class="num">Pos</th><th>No.</th><th>Name</th><th>Club</th>${forPrint && sc.groups.some(x => x.results.some(r => r.time)) ? '<th>Time</th>' : ''}<th class="num">Overall</th></tr></thead><tbody>
          ${g.results.map(r => `<tr><td class="num">${r.pos}</td><td>${esc(r.entry.id)}</td><td>${esc(r.entry.name)}</td><td>${esc(r.entry.team)}</td>${forPrint && sc.groups.some(x => x.results.some(r => r.time)) ? `<td>${esc(r.time)}</td>` : ''}<td class="num">${r.overall}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No finishers yet.</p>'}</div>`;
      }
      const pre = multi ? g.category + ' — ' : '';
      h += teamTable(g.teams.club, `${pre}Club teams (first ${g.config.club} score)`, { col: 'Club' });
      h += teamTable(g.teams.county, `${pre}County teams (first ${g.config.county} score)`, { col: 'County' });
      h += teamTable(g.teams.province, `${pre}Province teams (first ${g.config.province} score)`, { col: 'Province' });
      if (!forPrint && g.results.length && !g.teams.club.length && g.config.club) h += `<p class="muted small">${multi ? esc(g.category) + ': n' : 'N'}o club has ${g.config.club} finishers yet.</p>`;
    }
    for (const mt of sc.masters) {
      h += teamTable(mt.club, `${mt.category} — club teams`, { col: 'Club' });
      h += teamTable(mt.county, `${mt.category} — county teams`, { col: 'County' });
    }
    return h;
  }
  function viewResults() {
    const ev = currentEvent();
    if (!ev) return `<h2>Results &amp; scoring</h2><div class="card empty">Add races on the Program tab first.</div>`;
    const rows = resultsOf(ev);
    const sc = X.scoreEvent(scoringState(), ev, rows);
    const pills = S.program.map(p => { const n = (S.results[p.number] || []).length; return `<button class="event-pill ${p === ev ? 'active' : ''}" data-act="res-evt" data-n="${esc(p.number)}"><b>Event ${esc(p.number)}</b> ${esc(p.categories.join(' / '))}<small>${esc(p.distance)} · ${n ? n + ' finished' : 'no results'} / ${entriesFor(p).length} entered</small></button>`; }).join('');
    const lines = sc.lines.map((l, i) => `<tr class="${l.error ? (l.unscored || !l.pos ? 'err' : '') : ''}" data-i="${i}">
        <td class="num">${l.pos ?? '—'}</td>
        <td><input class="cell" data-ed="id" data-i="${i}" value="${esc(l.id)}" inputmode="numeric"></td>
        <td>${l.entry ? esc(l.entry.name) : ''}${l.error ? `<div class="small" style="color:var(--err)">${esc(l.error)}${l.error === 'Unknown number' ? ` <button class="btn small" data-act="res-addath" data-id="${esc(l.id)}">Add athlete…</button>` : ''}</div>` : ''}</td>
        <td class="small">${l.entry ? esc(l.entry.team) : ''}</td>
        ${ev.categories.length > 1 ? `<td class="small">${l.entry ? esc(l.entry.category) : ''}</td>` : ''}
        <td><input class="cell" data-ed="time" data-i="${i}" value="${esc(l.time)}" placeholder="time"></td>
        <td style="white-space:nowrap"><button class="btn icon small" data-act="res-up" data-i="${i}" title="Move up" ${i ? '' : 'disabled'}>↑</button><button class="btn icon small" data-act="res-down" data-i="${i}" title="Move down" ${i < rows.length - 1 ? '' : 'disabled'}>↓</button><button class="btn icon small" data-act="res-ins" data-i="${i}" title="Insert a finisher above">+</button><button class="btn icon small danger" data-act="res-del" data-i="${i}" title="Remove">✕</button></td>
      </tr>`).reverse().join('');
    const last = sc.lines[sc.lines.length - 1];
    return `<h2>Results &amp; scoring</h2>
      <div class="event-pills">${pills}</div>
      <div class="res-layout">
        <div class="card">
          <div class="row" style="margin-bottom:8px"><h3 style="margin:0">Finish order</h3><span class="pill">${sc.finishers} scored</span>${sc.errors ? `<span class="pill err">${sc.errors} to check</span>` : ''}<span class="spacer"></span>
            <button class="btn small" data-act="res-paste">Paste finish list…</button><button class="btn small danger" data-act="res-clear" ${rows.length ? '' : 'disabled'}>Clear</button></div>
          <div class="bib-entry">
            <label class="f">Bib number<input type="text" class="bib" id="bib" inputmode="numeric" autocomplete="off" placeholder="#" ${ui.insertAt != null ? 'style="outline:2px solid var(--warn)"' : ''}></label>
            <label class="f">Time (optional)<input type="text" class="time" id="btime" autocomplete="off" placeholder="mm:ss"></label>
            <button class="btn primary" data-act="res-add" style="height:42px">Add</button>
            <button class="btn" data-act="res-undo" style="height:42px" ${rows.length ? '' : 'disabled'}>Undo last</button>
          </div>
          <div class="last-added" id="last-added">${ui.insertAt != null ? `<span style="color:var(--warn)">Inserting above position ${ui.insertAt + 1} — <a href="#" data-act="res-insx">cancel</a></span>` : last ? (last.error ? `<span style="color:var(--err)">#${esc(last.id)}: ${esc(last.error)}</span>` : `Last: <b>${last.pos}. ${esc(last.entry.name)}</b> <span class="muted">${esc(last.entry.team)}</span>`) : '<span class="muted">Type a bib number and press <kbd>Enter</kbd>. Latest finisher shows at the top.</span>'}</div>
          ${rows.length ? `<div class="tbl-wrap" style="max-height:calc(100vh - 420px)"><table class="t lines-table"><thead><tr><th class="num">Pos</th><th>Bib</th><th>Name</th><th>Club</th>${ev.categories.length > 1 ? '<th>Cat</th>' : ''}<th>Time</th><th></th></tr></thead><tbody>${lines}</tbody></table></div>` : ''}
        </div>
        <div class="card">
          <div class="row" style="margin-bottom:8px"><h3 style="margin:0">Scores</h3><span class="spacer"></span>
            <button class="btn small primary" data-act="res-print">🖨 Print results</button><button class="btn small" data-act="res-xlsx">Excel</button><button class="btn small" data-act="res-print-all">Print all races</button></div>
          ${sc.finishers ? scoresHtml(ev, sc) : '<p class="muted">Team scores appear here as finishers are added.</p>'}
        </div>
      </div>`;
  }
  function afterResults() {
    const bib = $('#bib'); if (!bib) return;
    const time = $('#btime');
    if (!$('#modal-root').children.length) bib.focus();
    const add = () => {
      let v = bib.value.trim(); let t = time.value.trim();
      const m = v.match(/^(\S+)[\s,;]+(.+)$/); if (m) { v = m[1]; t = t || m[2]; }
      if (!v) return;
      const ev = currentEvent(); const rows = resultsOf(ev);
      if (ui.insertAt != null) { rows.splice(ui.insertAt, 0, { id: v, time: t }); ui.insertAt = null; }
      else rows.push({ id: v, time: t });
      commit();
    };
    bib.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
    });
    time.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    $$('input.cell').forEach(inp => inp.addEventListener('change', () => {
      const ev = currentEvent(); const r = resultsOf(ev)[+inp.dataset.i]; if (!r) return;
      r[inp.dataset.ed] = inp.value.trim(); commit();
    }));
    $$('input.cell').forEach(inp => inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); }));
  }
  function pasteResults() {
    const ev = currentEvent();
    const body = `<p class="small muted">Paste from the timing system or a spreadsheet: one finisher per line in finishing order. The bib and time columns are found automatically.</p>
      <textarea class="paste-zone" id="pr-text" placeholder="e.g.&#10;1	123	12:34&#10;2	87	12:40"></textarea>
      <div id="pr-info" class="small" style="margin-top:6px"></div>
      <div class="row" style="margin-top:8px"><label class="chk"><input type="radio" name="pr-mode" value="replace" checked> Replace current results</label><label class="chk"><input type="radio" name="pr-mode" value="append"> Add to the end</label></div>`;
    modal('Paste finish list — ' + eventLabel(ev), body, {
      wide: true, footer: '<button class="btn" data-c>Cancel</button><button class="btn primary" data-ok disabled>Use these results</button>', onMount: m => {
        let parsed = [];
        const ta = $('#pr-text', m.body); ta.focus();
        const analyse = () => {
          const rows = X.parseDelimited(ta.value).filter(r => r.some(Boolean));
          const width = Math.max(0, ...rows.map(r => r.length));
          let bibCol = -1, timeCol = -1;
          const stats = [];
          for (let j = 0; j < width; j++) {
            const vals = rows.map(r => r[j] || '').filter(Boolean);
            const nums = vals.filter(v => /^\d+$/.test(v)).map(Number);
            let seq = 0; for (let k = 1; k < nums.length; k++) if (nums[k] === nums[k - 1] + 1) seq++;
            const ids = byId(); const known = vals.filter(v => ids.has(v)).length;
            stats.push({ j, num: nums.length / (vals.length || 1), seq: nums.length > 2 ? seq / (nums.length - 1) : 0, time: vals.filter(v => /^\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?$/.test(v)).length / (vals.length || 1), known: known / (vals.length || 1) });
          }
          const numCols = stats.filter(s => s.num > 0.8);
          const best = numCols.filter(s => !(s.seq > 0.9 && numCols.length > 1)).sort((a, b) => b.known - a.known || a.j - b.j)[0] || numCols[0];
          if (best) bibCol = best.j;
          const tc = stats.filter(s => s.time > 0.6).sort((a, b) => b.time - a.time)[0]; if (tc) timeCol = tc.j;
          parsed = bibCol < 0 ? [] : rows.filter(r => /^\d+$/.test(r[bibCol] || '')).map(r => ({ id: r[bibCol], time: timeCol >= 0 ? r[timeCol] || '' : '' }));
          const ids = byId();
          $('#pr-info', m.body).innerHTML = parsed.length ? `Found <b>${parsed.length}</b> finishers — bib numbers from column ${bibCol + 1}${timeCol >= 0 ? `, times from column ${timeCol + 1}` : ''}. ${parsed.filter(p => !ids.has(p.id)).length ? `<span style="color:var(--err)">${parsed.filter(p => !ids.has(p.id)).length} numbers are not entered athletes.</span>` : ''}` : ta.value.trim() ? '<span style="color:var(--err)">No bib numbers found.</span>' : '';
          $('[data-ok]', m.el).disabled = !parsed.length;
        };
        ta.addEventListener('input', analyse);
        $('[data-c]', m.el).onclick = m.close;
        $('[data-ok]', m.el).onclick = () => {
          const mode = $('[name=pr-mode]:checked', m.body).value;
          if (mode === 'replace') S.results[ev.number] = parsed; else resultsOf(ev).push(...parsed);
          m.close(); commit(); toast(`${parsed.length} finishers added`);
        };
      },
    });
  }
  function resultsReport(ev) {
    const sc = X.scoreEvent(scoringState(), ev, resultsOf(ev));
    const hasTime = sc.lines.some(l => l.time);
    const multi = ev.categories.length > 1;
    return `${header()}<h2>Event ${esc(ev.number)} · ${esc(ev.distance)} ${esc(ev.categories.join(' / '))} — Results</h2>
      <table><thead><tr><th>Pos</th><th>No.</th><th>Name</th><th>Club</th>${multi ? '<th>Category</th>' : ''}${hasTime ? '<th>Time</th>' : ''}</tr></thead><tbody>
      ${sc.lines.filter(l => l.pos).map(l => `<tr><td>${l.pos}</td><td>${esc(l.id)}</td><td>${l.entry ? esc(l.entry.name) : '<i>Unknown</i>'}</td><td>${l.entry ? esc(l.entry.team) : ''}</td>${multi ? `<td>${l.entry ? esc(l.entry.category) : ''}</td>` : ''}${hasTime ? `<td>${esc(l.time)}</td>` : ''}</tr>`).join('')}
      </tbody></table>${scoresHtml(ev, sc, true).replace(/class="t"/g, '').replace(/<span class="pill">\d+<\/span>/g, '')}`;
  }
  function resultsSheet(ev) {
    const sc = X.scoreEvent(scoringState(), ev, resultsOf(ev));
    const rows = [], bold = new Set();
    rows.push([{ v: `Event ${ev.number} ${ev.distance} ${ev.categories.join('/')}`, h: true }]);
    bold.add(rows.length); rows.push(['Pos', 'No.', 'Name', 'Club', 'Scoring Team', 'County', 'Province', 'Age Category', 'Time']);
    sc.lines.forEach(l => rows.push([l.pos ?? '', /^\d+$/.test(l.id) ? +l.id : l.id, l.entry ? l.entry.name : l.error, l.entry ? l.entry.team : '', l.entry ? l.entry.scoringTeam || l.entry.team : '', l.entry ? l.entry.county : '', l.entry ? l.entry.province : '', l.entry ? l.entry.category : '', l.time]));
    const teams = (list, label, col) => { if (!list.length) return; rows.push([]); rows.push([{ v: label, h: true }]); bold.add(rows.length); rows.push(['Place', col, 'Positions', 'Points']); list.forEach(t => rows.push([t.place, t.name, t.positions.join(', '), t.points])); };
    const multi = ev.categories.length > 1;
    for (const g of sc.groups) {
      if (multi) { rows.push([]); rows.push([{ v: g.category, h: true }]); bold.add(rows.length); rows.push(['Pos', 'No.', 'Name', 'Club', 'Overall']); g.results.forEach(r => rows.push([r.pos, r.entry.id, r.entry.name, r.entry.team, r.overall])); }
      const pre = multi ? g.category + ' ' : '';
      teams(g.teams.club, pre + 'Club Team Points', 'Club'); teams(g.teams.county, pre + 'County Team Points', 'County'); teams(g.teams.province, pre + 'Province Team Points', 'Province');
    }
    for (const mt of sc.masters) { teams(mt.club, mt.category + ' Club Team Points', 'Club'); teams(mt.county, mt.category + ' County Team Points', 'County'); }
    return { name: `E${ev.number} ${ev.categories[0]}`, rows, bold, widths: [7, 8, 28, 30, 30, 12, 12, 18, 10] };
  }

  // ================================================================ reference data
  function viewSetup() {
    const tabs = { cats: 'Age categories & team scoring', clubs: `Clubs (${S.teams.length})`, other: 'Counties, provinces & masters teams' };
    let body = '';
    if (ui.setupTab === 'cats') {
      const d = derive();
      const sorted = [...S.ageCategories.map((c, i) => [c, i])].sort((a, b) => (d.progCats.has(b[0].name) - d.progCats.has(a[0].name)));
      const num = (i, k, v) => `<input type="number" min="0" max="20" style="width:52px" data-cat="${i}" data-k="${k}" value="${esc(v ?? 0)}">`;
      const chk = (i, k, v) => `<input type="checkbox" data-cat="${i}" data-k="${k}" ${v ? 'checked' : ''} title="Allow B/C teams">`;
      body = `<p class="small muted">Team size = how many finishers count for each team. Tick “multi” to score a club's next finishers as a B team, C team… Categories used in your program are listed first.</p>
        <div class="toolbar"><button class="btn small" data-act="cat-add">+ Add category</button></div>
        <div class="tbl-wrap"><table class="t small"><thead><tr><th>Name</th><th>Gender</th><th>Age</th><th>CC distance</th><th>RR distance</th><th class="c">Club team</th><th class="c">multi</th><th class="c">County team</th><th class="c">multi</th><th class="c">Province team</th><th class="c">multi</th><th title="Athletes in this category are only ranked inside the other categories of their race">Combined</th><th></th></tr></thead><tbody>
        ${sorted.map(([c, i]) => `<tr${d.progCats.has(c.name) ? ' style="background:#f6fbf7"' : ''}><td><input type="text" data-cat="${i}" data-k="name" value="${esc(c.name)}" style="min-width:180px"></td>
          <td><select data-cat="${i}" data-k="gender">${opt('', '—', !c.gender)}${opt('M', 'M', c.gender === 'M')}${opt('W', 'W', c.gender === 'W')}</select></td>
          <td><input type="number" style="width:52px" data-cat="${i}" data-k="age" value="${esc(c.age ?? '')}"></td>
          <td><input type="text" style="width:80px" data-cat="${i}" data-k="ccDistance" value="${esc(c.ccDistance)}"></td>
          <td><input type="text" style="width:80px" data-cat="${i}" data-k="rrDistance" value="${esc(c.rrDistance)}"></td>
          <td class="c">${num(i, 'cc.club', c.cc.club)}</td><td class="c">${chk(i, 'cc.clubMulti', c.cc.clubMulti)}</td>
          <td class="c">${num(i, 'cc.county', c.cc.county)}</td><td class="c">${chk(i, 'cc.countyMulti', c.cc.countyMulti)}</td>
          <td class="c">${num(i, 'cc.province', c.cc.province)}</td><td class="c">${chk(i, 'cc.provinceMulti', c.cc.provinceMulti)}</td>
          <td class="c"><input type="checkbox" data-cat="${i}" data-k="noOwnRanking" ${c.noOwnRanking ? 'checked' : ''}></td>
          <td><button class="btn icon small danger" data-act="cat-del" data-i="${i}">✕</button></td></tr>`).join('')}
        </tbody></table></div>`;
    } else if (ui.setupTab === 'clubs') {
      const q = X.lc(ui.clubQ);
      const list = S.teams.map((t, i) => [t, i]).filter(([t]) => !q || X.lc(t.name).includes(q) || X.lc(t.county).includes(q) || X.lc(t.code).includes(q));
      body = `<div class="toolbar"><input type="search" id="club-q" placeholder="Search clubs or county…" value="${esc(ui.clubQ)}" style="width:260px"><button class="btn small" data-act="club-add">+ Add club</button><button class="btn small" data-act="club-paste">Paste club list…</button><span class="spacer"></span><span class="small muted">${Object.keys(S.aliases).length} remembered spellings</span>${Object.keys(S.aliases).length ? '<button class="btn small" data-act="alias-clear">Forget them</button>' : ''}</div>
        <div class="tbl-wrap"><table class="t small"><thead><tr><th>Club name</th><th>Code</th><th>County</th><th>Province</th><th class="num">Athletes</th><th></th></tr></thead><tbody>
        ${list.map(([t, i]) => `<tr><td><input type="text" data-club="${i}" data-k="name" value="${esc(t.name)}"></td><td><input type="text" style="width:90px" data-club="${i}" data-k="code" value="${esc(t.code)}"></td>
          <td><select data-club="${i}" data-k="county">${listOptions(S.counties, t.county)}</select></td><td><select data-club="${i}" data-k="province">${listOptions(S.provinces, t.province)}</select></td>
          <td class="num">${S.entries.filter(e => e.team === t.name).length || ''}</td><td><button class="btn icon small danger" data-act="club-del" data-i="${i}">✕</button></td></tr>`).join('')}
        </tbody></table></div>`;
    } else {
      body = `<div class="grid g2" style="grid-template-columns:repeat(3,1fr)">
        <label class="f">Counties (one per line)<textarea rows="16" data-list="counties">${esc(S.counties.join('\n'))}</textarea></label>
        <label class="f">Provinces / regions (one per line)<textarea rows="16" data-list="provinces">${esc(S.provinces.join('\n'))}</textarea></label>
        <label class="f">Masters team categories (one per line)<textarea rows="16" data-list="mastersTeamCategories">${esc(S.mastersTeamCategories.join('\n'))}</textarea><span class="small muted" style="font-weight:400">Each needs a matching age category (for team size). Athletes are put in these with the Masters club/county team fields.</span></label></div>`;
    }
    return `<h2>Reference data</h2><p class="sub">Age categories, clubs and counties used by this competition. Pre-loaded from the Munster Athletics workbook.</p>
      <div class="toolbar"><div class="subtabs" style="margin:0">${Object.entries(tabs).map(([k, l]) => `<button data-act="setup-tab" data-k="${k}" class="${ui.setupTab === k ? 'active' : ''}">${esc(l)}</button>`).join('')}</div><span class="spacer"></span>
      <button class="btn small" data-act="ref-save" title="New competitions will start with this reference data">Use as default for new competitions</button><button class="btn small" data-act="ref-reset">Reset to built-in data</button></div>
      ${body}`;
  }
  function afterSetup() {
    $$('[data-cat]').forEach(inp => inp.addEventListener('change', () => {
      const c = S.ageCategories[+inp.dataset.cat]; const k = inp.dataset.k;
      const val = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? (inp.value === '' ? null : +inp.value) : inp.value.trim();
      if (k === 'name' && val !== c.name) {
        const old = c.name;
        if (!val || S.ageCategories.some(x => x !== c && x.name === val)) { toast('Category names must be unique', true); inp.value = old; return; }
        S.entries.forEach(e => { if (e.category === old) e.category = val; });
        S.program.forEach(p => { p.categories = p.categories.map(x => x === old ? val : x); });
      }
      if (k.includes('.')) { const [a, b] = k.split('.'); c[a][b] = val; } else c[k] = val;
      commit({ render: false });
    }));
    $$('[data-club]').forEach(inp => inp.addEventListener('change', () => {
      const t = S.teams[+inp.dataset.club]; const k = inp.dataset.k; const val = inp.value.trim();
      if (k === 'name' && val !== t.name) {
        if (!val || S.teams.some(x => x !== t && x.name === val)) { toast('Club names must be unique', true); inp.value = t.name; return; }
        S.entries.forEach(e => { if (e.team === t.name) e.team = val; if (e.scoringTeam === t.name) e.scoringTeam = val; });
        for (const a of Object.keys(S.aliases)) if (S.aliases[a] === t.name) S.aliases[a] = val;
      }
      t[k] = val; commit({ render: false });
    }));
    $$('[data-list]').forEach(ta => ta.addEventListener('change', () => { S[ta.dataset.list] = [...new Set(ta.value.split('\n').map(X.norm).filter(Boolean))]; commit({ render: false }); }));
    const q = $('#club-q');
    if (q) q.oninput = () => { ui.clubQ = q.value; const p = q.selectionStart; render(); const q2 = $('#club-q'); q2.focus(); q2.setSelectionRange(p, p); };
  }
  function pasteClubs() {
    const body = `<p class="small muted">Paste a list of clubs: name, then optionally county and province columns (from a spreadsheet or website). Existing clubs are updated.</p><textarea class="paste-zone" id="cl-text"></textarea>`;
    modal('Paste club list', body, {
      wide: true, footer: '<button class="btn" data-c>Cancel</button><button class="btn primary" data-ok>Add clubs</button>', onMount: m => {
        $('#cl-text', m.body).focus();
        $('[data-c]', m.el).onclick = m.close;
        $('[data-ok]', m.el).onclick = () => {
          const rows = X.parseDelimited($('#cl-text', m.body).value).filter(r => r[0]);
          let add = 0, upd = 0;
          for (const r of rows) {
            if (/^(club|team|name)$/i.test(r[0])) continue;
            const county = S.counties.find(c => X.lc(c) === X.lc(r[1])) || '';
            const prov = S.provinces.find(c => X.lc(c) === X.lc(r[2])) || '';
            const ex = S.teams.find(t => X.lc(t.name) === X.lc(r[0]));
            if (ex) { if (county) ex.county = county; if (prov) ex.province = prov; upd++; }
            else { S.teams.push({ name: r[0], code: '', county, province: prov }); add++; }
          }
          S.teams.sort((a, b) => a.name.localeCompare(b.name));
          m.close(); commit(); toast(`${add} clubs added, ${upd} updated`);
        };
      },
    });
  }

  // ================================================================ actions
  const actions = {
    'meet-new'() { newMeetDialog(); },
    'meet-open'(el) { openMeet(el.dataset.id); },
    'meet-copy'(el) { newMeetDialog(el.dataset.id); },
    'meet-copy-cur'() { flushSave().then(() => newMeetDialog(S.id)); },
    async 'meet-export'(el) { await flushSave(); const d = await DB.get(el.dataset.id); if (d) exportMeetFile(migrate(d)); },
    async 'meet-export-cur'() { await flushSave(); exportMeetFile(S); },
    'meet-import'() { pickImportMeet(); },
    'meet-import-xlsx'() { pickWorkbook(); },
    'sync-open'() { syncDialog(); },
    'meet-backup'() { backupAll(); },
    async 'meet-del'(el) {
      const m = summaries.find(x => x.id === el.dataset.id); if (!m) return;
      if (!confirm(`Delete “${m.title}”${m.date ? ' (' + fmtDate(m.date) + ')' : ''}?\n\nIts ${m.athletes} athletes and ${m.finishers} results will be removed. This can't be undone — export it first if you might need it.`)) return;
      if (S && S.id === m.id) { clearTimeout(saveTimer); S = null; dirty = false; localStorage.removeItem(LS_LAST); }
      await DB.del(m.id); await refreshSummaries(); ui.tab = 'meets'; render(); toast('Deleted ' + m.title); syncSoon(500);
    },
    'meet-del-cur'(el) { actions['meet-del']({ dataset: { id: S.id } }); },
    async 'load-sample'() {
      const d = JSON.parse($('#sample-data').textContent);
      const st = migrate(d); st.id = 'example-conna-2025';
      if (summaries.some(m => m.id === st.id)) { openMeet(st.id); return; }
      await addMeet(st, 'results'); toast('Added the example meet with ' + st.entries.length + ' athletes');
    },
    'export-all'() {
      const sheets = [
        { name: 'Competition', rows: [[{ v: S.settings.title, h: true }], ['Venue', S.settings.venue], ['Date', S.settings.date], ['Time', S.settings.time], ['Level', S.settings.regionLevel], ['Region', S.settings.region], [], ['Event', 'Categories', 'Type', 'Distance', 'Time', 'Entered', 'Finishers'], ...S.program.map(p => [p.number, p.categories.join(' / '), p.type, p.distance, p.time, entriesFor(p).length, (S.results[p.number] || []).length])], bold: new Set([7]), widths: [12, 40, 8, 12, 10, 10, 10] },
        entriesSheet(), bookletSheet(), clubListSheet(), checkInSheet(),
        ...S.program.filter(p => (S.results[p.number] || []).length).map(resultsSheet),
      ];
      downloadXlsx(S.settings.title, sheets);
    },
    // program
    'prog-add'() { const n = Math.max(0, ...S.program.map(p => +p.number || 0)) + 1; S.program.push({ number: n, categories: [], type: 'CC', distance: '', time: '' }); commit(); },
    'prog-quick': progQuick,
    'prog-del'(el) { const p = S.program[+el.dataset.i]; if ((S.results[p.number] || []).length && !confirm('This race has results. Delete it and its results?')) return; delete S.results[p.number]; S.program.splice(+el.dataset.i, 1); commit(); },
    'prog-up'(el) { const i = +el.dataset.i; [S.program[i - 1], S.program[i]] = [S.program[i], S.program[i - 1]]; commit(); },
    'prog-down'(el) { const i = +el.dataset.i; [S.program[i + 1], S.program[i]] = [S.program[i], S.program[i + 1]]; commit(); },
    'prog-delcat'(el) { S.program[+el.dataset.i].categories.splice(+el.dataset.ci, 1); commit(); },
    'prog-print'() { printHtml(programReport()); },
    // entries
    'ent-paste'() { importDialog(); },
    'ent-file'() { pickImportFile((rows, name) => importDialog(rows, name)); },
    'ent-add'() { editAthlete(null); },
    'ent-problems'() { ui.onlyProblems = !ui.onlyProblems; render(); },
    'ent-issues': showIssues,
    'ent-autofix'() {
      const f = autoFixes();
      const body = `<p class="small muted">These values only differ from the reference lists in capitals, punctuation or spacing.</p><table class="t small"><thead><tr><th>Athlete</th><th>Field</th><th>From</th><th>To</th></tr></thead><tbody>${f.map(x => `<tr><td>${esc(x.e.name)}</td><td>${esc(x.field)}</td><td>${esc(x.from)}</td><td><b>${esc(x.to)}</b></td></tr>`).join('')}</tbody></table>`;
      modal(`Fix ${f.length} spelling differences`, body, { wide: true, footer: '<button class="btn" data-c>Cancel</button><button class="btn primary" data-ok>Apply fixes</button>', onMount: m => {
        $('[data-c]', m.el).onclick = m.close;
        $('[data-ok]', m.el).onclick = () => { for (const x of f) { x.e[x.field] = x.to; if (x.field === 'scoringTeam' && x.e.scoringTeam === x.e.team) x.e.scoringTeam = ''; } m.close(); commit(); toast(`Fixed ${f.length} values`); };
      } });
    },
    'ent-delsel'() { if (!confirm(`Delete ${ui.sel.size} athletes?`)) return; S.entries = S.entries.filter(e => !ui.sel.has(e.uid)); ui.sel.clear(); commit(); },
    'ent-clearsel'() { ui.sel.clear(); render(); },
    'ent-bulk': bulkEdit,
    'ent-renumber': renumber,
    'ent-export'() { downloadXlsx(S.settings.title + ' - athletes', [entriesSheet()]); },
    // lists
    'list-tab'(el) { ui.listTab = el.dataset.k; render(); },
    'list-print'() { printHtml({ booklet: bookletReport, clubs: clubListReport, checkin: checkInReport, program: programReport }[ui.listTab]()); },
    'list-xlsx'() { const s = { booklet: bookletSheet, clubs: clubListSheet, checkin: checkInSheet }[ui.listTab](); downloadXlsx(S.settings.title + ' - ' + s.name, [s]); },
    'list-csv'() { const s = { booklet: bookletSheet, clubs: clubListSheet, checkin: checkInSheet }[ui.listTab](); downloadCsv(S.settings.title + ' - ' + s.name, s.rows); },
    // results
    'res-evt'(el) { ui.evt = el.dataset.n; ui.insertAt = null; render(); },
    'res-add'() { const bib = $('#bib'); bib.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); },
    'res-undo'() { const r = resultsOf(currentEvent()); r.pop(); commit(); },
    'res-clear'() { if (confirm('Clear all results for this race?')) { S.results[currentEvent().number] = []; commit(); } },
    'res-up'(el) { const r = resultsOf(currentEvent()); const i = +el.dataset.i; [r[i - 1], r[i]] = [r[i], r[i - 1]]; commit(); },
    'res-down'(el) { const r = resultsOf(currentEvent()); const i = +el.dataset.i; [r[i + 1], r[i]] = [r[i], r[i + 1]]; commit(); },
    'res-del'(el) { resultsOf(currentEvent()).splice(+el.dataset.i, 1); commit(); },
    'res-ins'(el) { ui.insertAt = +el.dataset.i; render(); },
    'res-insx'() { ui.insertAt = null; render(); },
    'res-paste': pasteResults,
    'res-print'() { printHtml(resultsReport(currentEvent())); },
    'res-print-all'() { const evs = S.program.filter(p => (S.results[p.number] || []).length); if (!evs.length) { toast('No results yet', true); return; } printHtml(evs.map((ev, i) => `<div class="${i < evs.length - 1 ? 'page-break' : ''}">${resultsReport(ev)}</div>`).join('')); },
    'res-xlsx'() { const ev = currentEvent(); downloadXlsx(`${S.settings.title} - Event ${ev.number} results`, [resultsSheet(ev)]); },
    'res-addath'(el) { const ev = currentEvent(); editAthlete(null, { id: +el.dataset.id, category: ev.categories.length === 1 ? ev.categories[0] : '' }); },
    // setup
    'setup-tab'(el) { ui.setupTab = el.dataset.k; render(); },
    'cat-add'() { S.ageCategories.unshift({ name: 'New category ' + (S.ageCategories.length + 1), code: '', gender: '', age: null, dobFrom: null, dobTo: null, ccDistance: '', rrDistance: '', cc: { club: 4, clubMulti: false, county: 6, countyMulti: false, province: 6, provinceMulti: false }, rr: { club: 4, clubMulti: false, county: 6, countyMulti: false, province: 6, provinceMulti: false }, noOwnRanking: false, scoresIn: [] }); commit(); },
    'cat-del'(el) { const c = S.ageCategories[+el.dataset.i]; const n = S.entries.filter(e => e.category === c.name).length; if (n && !confirm(`${n} athletes use "${c.name}". Delete it anyway?`)) return; S.ageCategories.splice(+el.dataset.i, 1); commit(); },
    'club-add'() { newClubDialog('', (name, county, province) => { if (S.teams.some(t => t.name === name)) { toast('That club already exists', true); return; } S.teams.push({ name, code: '', county, province }); S.teams.sort((a, b) => a.name.localeCompare(b.name)); ui.clubQ = name; commit(); }); },
    'club-del'(el) { const t = S.teams[+el.dataset.i]; const n = S.entries.filter(e => e.team === t.name).length; if (n && !confirm(`${n} athletes are in ${t.name}. Delete the club anyway?`)) return; S.teams.splice(+el.dataset.i, 1); commit(); },
    'club-paste': pasteClubs,
    'alias-clear'() { S.aliases = {}; commit(); },
    'ref-save'() { localStorage.setItem(LS_REF, JSON.stringify({ ageCategories: S.ageCategories, mastersTeamCategories: S.mastersTeamCategories, teams: S.teams, counties: S.counties, provinces: S.provinces, aliases: S.aliases })); toast('Saved as the default for new competitions'); },
    'ref-reset'() { if (!confirm('Replace this competition’s categories, clubs and counties with the built-in data? Athletes keep their current values.')) return; localStorage.removeItem(LS_REF); const r = clone(SEED); Object.assign(S, { ageCategories: r.ageCategories, mastersTeamCategories: r.mastersTeamCategories, teams: r.teams, counties: r.counties, provinces: r.provinces }); commit(); },
  };

  // ================================================================ global wiring
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (t && actions[t.dataset.act] && t.tagName !== 'SELECT') { e.preventDefault(); actions[t.dataset.act](t); return; }
    const tab = e.target.closest('#tabs [data-tab]');
    if (tab) { ui.tab = tab.dataset.tab; ui.insertAt = null; render(); $('#view').scrollTop = 0; }
  });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('[data-act="prog-addcat"]')) { if (t.value) { const p = S.program[+t.dataset.i]; if (!p.categories.includes(t.value)) p.categories.push(t.value); if (!p.distance) { const c = derive().catByName.get(t.value); if (c) p.distance = p.type === 'RR' ? c.rrDistance : c.ccDistance; } commit(); } return; }
    if (t.matches('[data-pf]')) {
      const p = S.program[+t.dataset.i]; const k = t.dataset.pf; let v = t.value.trim();
      if (k === 'number') {
        v = +v; if (S.program.some(x => x !== p && +x.number === v)) { toast('Event numbers must be unique', true); t.value = p.number; return; }
        if (S.results[p.number]) { S.results[v] = S.results[p.number]; delete S.results[p.number]; }
      }
      p[k] = v; commit({ render: k === 'number' }); return;
    }
    if (t.matches('[data-set]')) {
      const k = t.dataset.set; S.settings[k] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? +t.value : t.value;
      commit({ render: k === 'regionLevel' }); return;
    }
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (S) { dirty = true; flushSave().then(() => toast('Saved')); } }
  });
  $('#file-open').addEventListener('change', async e => { for (const f of e.target.files) await importText(await f.text(), f.name); e.target.value = ''; });
  window.addEventListener('beforeunload', e => { if (dirty || saving) { flushSave(); e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
  // paste anywhere on the athletes tab opens the importer
  document.addEventListener('paste', e => {
    if (ui.tab !== 'entries' || $('#modal-root').children.length) return;
    if (e.target && e.target.closest && e.target.closest('input,textarea,select')) return;
    const html = e.clipboardData.getData('text/html'), text = e.clipboardData.getData('text/plain');
    let rows = null;
    if (html) { try { rows = X.parseHtmlTables(html); } catch (err) { rows = null; } }
    if (!rows || !rows.length) rows = X.parseDelimited(text);
    if (!rows.some(r => r.some(Boolean))) return;
    e.preventDefault();
    importDialog(rows, 'Pasted');
  });

  // ================================================================ boot
  (async () => {
    try {
      await DB.open();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      // bring across the single autosaved meet from version 1.0
      try {
        const old = JSON.parse(localStorage.getItem(LS_CUR));
        if (old && old.state) { const st = migrate(old.state); if (!st.entries.length && !st.program.length) throw 0; await DB.put(st); localStorage.setItem(LS_LAST, st.id); }
      } catch (e) { /* nothing to migrate */ }
      localStorage.removeItem(LS_CUR);
      await refreshSummaries();
      const last = localStorage.getItem(LS_LAST);
      if (last && summaries.some(m => m.id === last)) { const d = await DB.get(last); S = migrate(d); ui.tab = 'meets'; }
    } catch (e) {
      $('#view').innerHTML = `<div class="wrap"><div class="notice err">Could not open the meets database: ${esc(e.message || e)}. Make sure you open the app with the launcher.</div></div>`;
      return;
    }
    window.XCApp = { get state() { return S; }, actions, ui, render, importDialog, get summaries() { return summaries; }, flushSave, syncNow, Sync };
    render();
    startSync();
  })();
})();
