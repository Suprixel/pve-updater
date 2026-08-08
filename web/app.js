/* ---------------------------------------------------------------------------
   pve-updater dashboard.

   Add a tab      : write a render function, add one entry to VIEWS. Optional
                    hooks per entry: enter() before the first paint, mount()
                    after every paint, manual:true to keep background refreshes
                    from repainting it (used by Monitor so iframes survive).
   Add a setting  : add the key to SCHEMA in server.py, then one line in
                    FIELDS / NUMS / TEXTS below.
   Add a look     : theme.css. No colours live in this file.
--------------------------------------------------------------------------- */

/* ------------------------------------------------------------ preferences */
const PREF_KEY = 'pve-ui';
const PREF_DEFAULTS = {
  width: 'full', accent: '#FFB224', text: 'md', density: 'cozy', motion: 'auto',
  monMode: 'grid', monCols: 2, logMode: 'open', logHeight: 280,
};
const LEGACY_ACCENT = { amber: '#FFB224', green: '#3ECF8E', blue: '#5AA9FF', violet: '#B392FF' };
let P = Object.assign({}, PREF_DEFAULTS);
try { P = Object.assign(P, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) {}
if (LEGACY_ACCENT[P.accent]) P.accent = LEGACY_ACCENT[P.accent];

/* ------------------------------------------------------------ colour maths */
function hex2rgb(h) {
  const s = String(h || '').replace('#', '');
  const v = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
  const i = parseInt(v.slice(0, 6), 16);
  return isNaN(i) ? [255, 178, 36] : [(i >> 16) & 255, (i >> 8) & 255, i & 255];
}
function rgb2hex(r) {
  return '#' + r.map(v => Math.round(Math.max(0, Math.min(255, v)))
    .toString(16).padStart(2, '0')).join('').toUpperCase();
}
function normHex(h) {
  const s = String(h || '').trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(s) ? rgb2hex(hex2rgb(s)) : null;
}
function lum(rgb) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function rgb2hsl(r) {
  const [R, G, B] = r.map(v => v / 255);
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  let h = 0;
  if (d) {
    h = mx === R ? ((G - B) / d + (G < B ? 6 : 0)) : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h *= 60;
  }
  const l = (mx + mn) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return [h, s, l];
}
function hsl2rgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  const t = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
          : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return t.map(v => (v + m) * 255);
}
/* a version of the accent that stays legible as text on a black background */
function readable(hex) {
  const [h, s, l] = rgb2hsl(hex2rgb(hex));
  if (l >= 0.52) return hex;
  return rgb2hex(hsl2rgb(h, Math.max(s, 0.45), 0.62));
}
function alpha(hex, a) {
  const [r, g, b] = hex2rgb(hex);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(P)); } catch (e) {}
  applyPrefs();
}
function applyPrefs() {
  const d = document.documentElement.dataset;
  d.width = P.width; d.text = P.text; d.density = P.density; d.motion = P.motion;

  const hex = normHex(P.accent) || PREF_DEFAULTS.accent;
  const st = document.documentElement.style;
  st.setProperty('--accent', hex);
  st.setProperty('--accent-text', readable(hex));
  st.setProperty('--accent-ink', lum(hex2rgb(hex)) > 0.42 ? '#120C02' : '#FFFFFF');
  st.setProperty('--accent-soft', alpha(hex, 0.10));
  st.setProperty('--accent-line', alpha(hex, 0.38));
}
applyPrefs();

function setAccent(v) {
  const hex = normHex(v);
  if (!hex) return false;
  P.accent = hex; savePrefs();
  return true;
}

/* ------------------------------------------------------------------ state */
const S = {
  index: null, report: null, state: null, mon: null, monSel: null,
  view: 'overview', sel: null, q: '', pkgq: '', conf: null, confDraft: null,
  saving: false, logOffset: 0, logText: '', polling: null, probeTimer: null,
  menuOpen: false, api: true, _t: '', live: { running: false, exit: null },
  monDown: new Set(),
};

const $ = s => document.querySelector(s);
const $$ = s => Array.prototype.slice.call(document.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = x => Number(x) || 0;

/* ------------------------------------------------------------------ icons */
const svg = d => '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
const ICON = {
  updates:  svg('<path d="M12 3v11"/><path d="M8 11l4 4 4-4"/><path d="M4 20h16"/>'),
  services: svg('<rect x="3.5" y="4" width="7" height="7" rx="1.5"/>'
              + '<rect x="13.5" y="4" width="7" height="7" rx="1.5"/>'
              + '<rect x="3.5" y="14" width="7" height="6" rx="1.5"/>'
              + '<rect x="13.5" y="14" width="7" height="6" rx="1.5"/>'),
  monitor:  svg('<path d="M3 12h4l3 7 4-14 3 7h4"/>'),
  history:  svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v5h5"/>'
              + '<path d="M12 8.5V12l2.5 1.7"/>'),
  settings: svg('<path d="M4 7h9"/><path d="M17.5 7H20"/><circle cx="15.2" cy="7" r="2.2"/>'
              + '<path d="M4 17h3.5"/><path d="M12 17h8"/><circle cx="9.7" cy="17" r="2.2"/>'),
  key:      svg('<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21"/>'
              + '<path d="M17.5 12v3"/><path d="M20 12v2.5"/>'),
};

/* ------------------------------------------------------------------- tabs */
const VIEWS = [
  { id: 'overview', label: 'Updates',  icon: ICON.updates,  view: () => overview() },
  { id: 'services', label: 'Services', icon: ICON.services, view: () => services() },
  { id: 'monitor',  label: 'Monitor',  icon: ICON.monitor,  view: () => monitor(),
    enter: loadMonitor, mount: monMount, manual: true },
  { id: 'history',  label: 'History',  icon: ICON.history,  view: () => history() },
  { id: 'settings', label: 'Settings', icon: ICON.settings, view: () => settings() },
];
const viewDef = id => VIEWS.find(v => v.id === id) || VIEWS[0];

/* ------------------------------------------------------------------ token */
const store = {
  get() { try { return localStorage.getItem('pve-token') || ''; } catch (e) { return S._t; } },
  set(v) { S._t = v; try { localStorage.setItem('pve-token', v); } catch (e) {} },
  clear() { S._t = ''; try { localStorage.removeItem('pve-token'); } catch (e) {} },
};

async function api(path, opts) {
  const o = Object.assign({
    headers: { 'X-PVE-Token': store.get(), 'Content-Type': 'application/json' },
  }, opts || {});
  const r = await fetch(path, o);
  if (r.status === 401) { askKey(); throw new Error('unauthorised'); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || ('request failed: ' + r.status));
  return body;
}

/* ----------------------------------------------------------------- format */
function when(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return 'today at ' + t;
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
         + ' at ' + t;
}
function dur(s) {
  s = n(s);
  return s < 60 ? s + ' seconds' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
}
function word(st) {
  return { ok: 'all good', warn: 'needs a look', error: 'failed',
           skipped: 'skipped' }[st] || st;
}

/* ------------------------------------------------------------------- boot */
async function boot() {
  const hash = (location.hash || '').replace('#', '');
  if (VIEWS.some(v => v.id === hash)) S.view = hash;

  try { S.state = await (await fetch('/api/state')).json(); }
  catch (e) { S.api = false; }

  try { S.index = await (await fetch('reports/index.json?_=' + Date.now())).json(); }
  catch (e) { S.index = { runs: [] }; }

  const runs = S.index.runs || [];
  if (runs.length) { try { await loadRun(runs[0].run_id); } catch (e) { S.report = null; } }

  const v = viewDef(S.view);
  render();
  if (v.enter) v.enter();
  if (S.state && S.state.run && S.state.run.running) startConsole();
}

async function loadRun(id) {
  S.report = await (await fetch('reports/' + encodeURIComponent(id) + '.json?_=' + Date.now())).json();
  const ts = S.report.targets || [];
  const first = ts.find(t => t.type === 'host') || ts[0];
  S.sel = first ? first.id : null;
  S.pkgq = '';
}

function setView(id) {
  if (S.probeTimer) { clearInterval(S.probeTimer); S.probeTimer = null; }
  S.view = id; S.menuOpen = false;
  try { history.replaceState(null, '', '#' + id); } catch (e) {}
  render();
  const v = viewDef(id);
  if (v.enter) v.enter();
}

/* --------------------------------------------------------------- top bar */
function renderTabs() {
  $('#tabs').innerHTML = VIEWS.map(v =>
    '<button role="tab" data-view="' + v.id + '" aria-selected="' + (v.id === S.view) + '">'
    + v.icon + '<span>' + esc(v.label) + '</span></button>').join('');
}

function renderPulse() {
  const r = S.report, t = (r && r.totals) || {};
  const running = S.state && S.state.run && S.state.run.running;
  let cls = 'ok', txt = 'up to date';
  if (running) { cls = 'warn'; txt = 'running'; }
  else if (!r) { cls = ''; txt = 'no runs yet'; }
  else if (n(t.errors)) { cls = 'error'; txt = n(t.errors) + ' faults'; }
  else if (n(t.warnings)) { cls = 'warn'; txt = 'needs a look'; }
  $('#pulse').innerHTML = '<span class="dot ' + cls + '"></span>' + esc(txt);
  const k = $('#keybtn');
  k.title = store.get() ? 'Access key stored' : 'Add the access key';
  k.style.color = store.get() ? '' : 'var(--accent)';
}

/* ------------------------------------------------------------------ cards */
function guestList() {
  const targets = (S.report && S.report.targets) || [];
  const byId = {};
  targets.forEach(t => { byId[t.id] = t; });
  const rows = [];

  const host = targets.find(t => t.type === 'host');
  if (host) rows.push(Object.assign({}, host, { kind: 'node' }));

  const live = (S.state && S.state.guests) || [];
  if (live.length) {
    live.forEach(g => {
      const t = byId[g.id];
      const kind = g.type === 'qemu' ? 'vm' : 'lxc';
      if (t) rows.push(Object.assign({}, t, { kind: kind, power: g.status }));
      else rows.push({
        id: g.id, name: g.name, type: g.type, kind: kind, power: g.status,
        status: 'unmanaged', unmanaged: true,
        note: g.type === 'qemu' ? 'Proxmox VM, not touched by the updater'
                                : 'Not covered by the last run',
      });
    });
  } else {
    targets.forEach(t => { if (t.type !== 'host') rows.push(Object.assign({}, t, { kind: 'lxc' })); });
  }
  return rows;
}

function cards() {
  return '<div class="grid">' + guestList().map((g, i) => {
    const cls = g.unmanaged ? 'unmanaged' : (g.status || '');
    const pk = n(g.packages && g.packages.upgraded);
    const im = n(g.docker && g.docker.images_updated);
    const st = (g.stacks || []).length;
    let body;
    if (g.unmanaged) body = '<div class="quiet">' + esc(g.note) + '</div>';
    else if (g.skipped) body = '<div class="quiet">Skipped &mdash; ' + esc(g.note || 'not included') + '</div>';
    else if (!pk && !im) body = '<div class="quiet">Already up to date'
      + (st ? ' &middot; ' + st + ' stack' + (st === 1 ? '' : 's') : '') + '</div>';
    else body = '<div class="facts">'
      + (pk ? '<span><b class="num">' + pk + '</b> package' + (pk === 1 ? '' : 's') + '</span>' : '')
      + (im ? '<span><b class="num">' + im + '</b> image' + (im === 1 ? '' : 's') + '</span>' : '')
      + (st ? '<span><b class="num">' + st + '</b> stack' + (st === 1 ? '' : 's') + '</span>' : '')
      + (g.disk_used_pct ? '<span><b class="num">' + esc(g.disk_used_pct) + '%</b> disk</span>' : '')
      + '</div>';

    return '<button class="card ' + cls + ' reveal" style="animation-delay:' + (i * 26) + 'ms"'
      + ' aria-current="' + (g.id === S.sel) + '" data-card="' + esc(g.id) + '"'
      + (g.unmanaged ? ' disabled' : '') + '>'
      + '<span class="card-top">'
      + '<span class="dot ' + esc(g.unmanaged ? '' : g.status) + '"></span>'
      + (g.type === 'host' ? '' : '<span class="cid num">' + esc(g.id) + '</span>')
      + '<span class="kind">' + esc(g.kind) + '</span></span>'
      + '<h3>' + esc(g.name) + '</h3>'
      + '<span class="os">' + esc(g.os && g.os !== 'unknown' ? g.os : (g.power || '')) + '</span>'
      + body + '</button>';
  }).join('') + '</div>';
}

/* ----------------------------------------------------------------- detail */
function pkgRows(list) {
  if (!list.length)
    return '<tr><td colspan="4" class="path">No package matches that filter.</td></tr>';
  return list.map(p => '<tr>'
    + '<td class="pkgname">' + esc(p.name) + '</td>'
    + '<td class="ver">' + (esc(p.from) || '&mdash;') + '</td>'
    + '<td class="ver arrow">&rarr;</td>'
    + '<td class="ver to">' + esc(p.to) + '</td></tr>').join('');
}

function packages(t) {
  const list = (t.packages && t.packages.list) || [];
  const count = n(t.packages && t.packages.upgraded);
  if (!list.length) {
    return '<div class="panel"><h3>Packages</h3><p class="empty" style="padding:6px 0">'
      + (count
        ? count + ' package' + (count === 1 ? '' : 's') + ' changed, but this package manager '
          + 'does not report names. The run log has the raw output.'
        : 'Nothing to upgrade, this one was already current.')
      + '</p></div>';
  }
  const q = S.pkgq.trim().toLowerCase();
  const hit = list.filter(p => !q || p.name.toLowerCase().indexOf(q) >= 0);
  return '<div class="panel"><div class="phead">'
    + '<h3 style="margin:0">' + list.length + ' package' + (list.length === 1 ? '' : 's') + ' '
    + (S.report.dry_run ? 'pending' : 'upgraded') + '</h3>'
    + (list.length > 12
      ? '<div style="margin-left:auto;width:min(280px,100%)">'
        + '<input type="search" id="pkgq" placeholder="Filter packages" value="' + esc(S.pkgq) + '"></div>'
      : '')
    + '</div><div class="scroll"><table><thead><tr>'
    + '<th>Package</th><th>From</th><th></th><th>To</th></tr></thead>'
    + '<tbody id="pkgbody">' + pkgRows(hit) + '</tbody></table></div></div>';
}

function detail() {
  const t = ((S.report && S.report.targets) || []).find(x => x.id === S.sel);
  if (!t) return '';
  const p = t.packages || {}, d = t.docker || {};

  let out = '<div class="panel"><div class="phead">'
    + '<div><h2>' + esc(t.name) + '</h2><div class="lbl">'
    + (t.type === 'host' ? 'Proxmox node' : 'Container ' + esc(t.id)) + '</div></div>'
    + '<span class="chip ' + esc(t.status) + '">' + word(t.status) + '</span>'
    + '<div class="actions"><button data-runone="' + esc(t.id) + '"'
    + (t.type === 'host' ? ' disabled' : '') + '>Update just this one</button></div></div>';

  if (t.status === 'error')
    out += '<div class="note bad">Something failed here' + (t.note ? ': ' + esc(t.note) : '')
      + '. The <a href="' + esc(S.report.log) + '" target="_blank">run log</a> has the exact output.</div>';
  else if (t.reboot_required)
    out += '<div class="note">A restart is pending. The kernel or libc was replaced, so running '
      + 'processes are still on the old version.</div>';
  else if (t.note)
    out += '<div class="note">' + esc(t.note) + '</div>';

  out += '<div class="meta">'
    + '<div><span class="lbl">System</span><b>' + esc(t.os) + '</b></div>'
    + '<div><span class="lbl">Packages via</span><b>' + esc(p.manager || 'n/a') + '</b></div>'
    + '<div><span class="lbl">Root disk</span><b class="num">'
    + (t.disk_used_pct ? t.disk_used_pct + '% used' : '&mdash;') + '</b></div>'
    + '<div><span class="lbl">Compose</span><b>'
    + (d.present ? esc(d.compose) : 'not installed') + '</b></div>'
    + (d.reclaimed ? '<div><span class="lbl">Disk reclaimed</span><b class="num">'
        + esc(d.reclaimed) + '</b></div>' : '')
    + (t.snapshot ? '<div><span class="lbl">Snapshot</span><b class="m">'
        + esc(t.snapshot) + '</b></div>' : '')
    + '</div></div>';

  out += packages(t);

  if ((t.stacks || []).length) {
    out += '<div class="panel"><h3>Compose stacks</h3><table><thead><tr>'
      + '<th>Stack</th><th>File</th><th>Images</th><th>Result</th></tr></thead><tbody>'
      + t.stacks.map(s => '<tr><td>' + esc(s.project) + '</td>'
        + '<td class="path">' + esc(s.file) + '</td>'
        + '<td class="num">' + (s.updated ? '<span class="tag new">' + s.updated + ' pulled</span> ' : '')
        + esc(String(s.images)) + ' total</td>'
        + '<td><span class="chip ' + esc(s.status) + '">' + word(s.status) + '</span>'
        + (s.note ? '<div class="path">' + esc(s.note) + '</div>' : '') + '</td></tr>').join('')
      + '</tbody></table></div>';
  }

  if ((t.containers || []).length) {
    out += '<div class="panel"><h3>Containers</h3><table><thead><tr>'
      + '<th>Name</th><th>Image</th><th>Ports</th><th>State</th></tr></thead><tbody>'
      + t.containers.map(c => {
        const upd = (t.images || []).some(i => i.image === c.image && i.updated);
        return '<tr><td>' + esc(c.name) + '</td>'
          + '<td class="path">' + esc(c.image) + (upd ? ' <span class="tag new">new</span>' : '') + '</td>'
          + '<td class="path">' + (esc(c.ports) || '&mdash;') + '</td>'
          + '<td><span class="tag ' + (c.state === 'running' ? 'run' : '') + '">'
          + esc(c.state) + '</span></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  if ((t.orphans || []).length) {
    out += '<div class="panel"><h3>Compose files nobody is running</h3>'
      + '<p class="path" style="margin:0 0 12px">Found on disk with no project attached, '
      + 'so nothing was pulled or started.</p>'
      + t.orphans.map(o => '<div class="path">' + esc(o) + '</div>').join('') + '</div>';
  }
  return out;
}

/* ------------------------------------------------------- view: updates */
function updateHead() {
  const r = S.report;
  const node = (S.state && S.state.node) || (r && r.node) || 'this node';
  let head, sub;

  if (!r) {
    head = 'Nothing has run yet';
    sub = 'Start with <b>Discover only</b> in the Run update menu. It maps every service on '
        + esc(node) + ' without changing a thing.';
  } else {
    const t = r.totals || {}, bad = n(t.errors), warn = n(t.warnings);
    if (bad) head = bad === 1 ? 'One guest failed to update' : bad + ' guests failed to update';
    else if (warn) head = warn === 1 ? 'One guest wants a look' : warn + ' guests want a look';
    else if (n(t.packages) || n(t.images)) head = 'Updated and healthy';
    else head = 'Everything is already up to date';

    const bits = ['Last run ' + when(r.started) + ', took ' + dur(r.duration)];
    if (r.dry_run) bits.push('dry run, nothing was changed');
    if (S.state && S.state.next_run && S.state.next_run !== 'not scheduled')
      bits.push('next ' + esc(S.state.next_run));
    sub = bits.join(' &middot; ');
  }
  return '<div class="viewhead"><div><h1>' + esc(head) + '</h1>'
    + '<p class="sub">' + sub + '</p></div></div>';
}

function overview() {
  if (!S.report) return updateHead() + cards();
  const t = S.report.totals || {}, dry = S.report.dry_run;
  return updateHead()
    + '<div class="strip">'
    + '<div class="stat ' + (n(t.packages) ? 'hot' : '') + '"><span class="v num">'
    + n(t.packages) + '</span><span class="lbl">packages ' + (dry ? 'pending' : 'upgraded') + '</span></div>'
    + '<div class="stat ' + (n(t.images) ? 'hot' : '') + '"><span class="v num">'
    + n(t.images) + '</span><span class="lbl">images ' + (dry ? 'checked' : 'pulled') + '</span></div>'
    + '<div class="stat"><span class="v num">' + n(t.stacks) + '</span>'
    + '<span class="lbl">stacks found</span></div>'
    + '<div class="stat ' + (n(t.errors) ? 'bad' : '') + '"><span class="v num">'
    + n(t.errors) + '</span><span class="lbl">faults</span></div>'
    + '<div class="right"><div class="lbl">run ' + esc(S.report.run_id) + '</div>'
    + '<a href="' + esc(S.report.log) + '" target="_blank">open the full log</a></div>'
    + '</div>' + cards() + detail();
}

/* ------------------------------------------------------ view: services */
function mapRows() {
  const rows = [];
  ((S.report && S.report.targets) || []).forEach(t => {
    (t.containers || []).forEach(c => {
      const st = (t.stacks || []).find(s => s.project === c.project);
      rows.push(Object.assign({ ct: t.id, ctname: t.name, file: st ? st.file : '' }, c));
    });
  });
  return rows;
}
function mapBody(rows) {
  const q = S.q.trim().toLowerCase();
  const hit = rows.filter(r => !q ||
    [r.name, r.image, r.ports, r.project, r.ctname, r.ct, r.file]
      .join(' ').toLowerCase().indexOf(q) >= 0);
  return {
    body: hit.map(r => '<tr><td>' + esc(r.name) + '</td>'
      + '<td><span class="num m">' + esc(r.ct) + '</span> ' + esc(r.ctname) + '</td>'
      + '<td>' + (esc(r.project) || '&mdash;') + '<div class="path">' + esc(r.file) + '</div></td>'
      + '<td class="path">' + (esc(r.ports) || '&mdash;') + '</td>'
      + '<td class="path">' + esc(r.image) + '</td></tr>').join('')
      || '<tr><td colspan="5" class="path">Nothing matches that search.</td></tr>',
    count: hit.length + ' of ' + rows.length + ' services',
  };
}
function services() {
  const rows = mapRows();
  const r = mapBody(rows);
  const orphans = [];
  ((S.report && S.report.targets) || []).forEach(t =>
    (t.orphans || []).forEach(o => orphans.push({ ct: t.id, ctname: t.name, file: o })));

  return '<div class="viewhead"><div><h2>Every service on this node</h2>'
    + '<p class="sub">Which container it runs in, which stack owns it, which port it '
    + 'answers on.</p></div></div>'
    + '<div class="panel">'
    + '<input type="search" id="q" placeholder="Search by name, image, stack or port" value="'
    + esc(S.q) + '">'
    + (!rows.length ? '<p class="empty">No containers were found in this run.</p>'
      : '<div style="margin-top:16px" class="scroll"><table><thead><tr>'
        + '<th>Service</th><th>Runs in</th><th>Stack</th><th>Ports</th><th>Image</th>'
        + '</tr></thead><tbody id="mapbody">' + r.body + '</tbody></table></div>'
        + '<p class="lbl" id="mapcount" style="margin:14px 0 0">' + r.count + '</p>')
    + '</div>'
    + (orphans.length ? '<div class="panel"><h3>Compose files nobody is running</h3>'
      + '<table><thead><tr><th>Container</th><th>File</th></tr></thead><tbody>'
      + orphans.map(o => '<tr><td><span class="num m">' + esc(o.ct) + '</span> '
        + esc(o.ctname) + '</td><td class="path">' + esc(o.file) + '</td></tr>').join('')
      + '</tbody></table></div>' : '');
}

/* ------------------------------------------------------- view: history */
function history() {
  const runs = (S.index && S.index.runs) || [];
  const head = '<div class="viewhead"><div><h2>Run history</h2>'
    + '<p class="sub">The last ' + (runs.length || 0) + ' runs kept on the node.</p></div></div>';
  if (!runs.length) return head + '<div class="panel"><p class="empty">No runs recorded yet.</p></div>';
  return head + '<div class="panel">'
    + '<table><thead><tr><th>When</th><th>Result</th>'
    + '<th class="hide-s">Packages</th><th class="hide-s">Images</th>'
    + '<th class="hide-s">Took</th><th></th></tr></thead><tbody>'
    + runs.map(r => '<tr><td>' + esc(when(r.started)) + '</td>'
      + '<td><span class="chip ' + esc(r.status) + '">' + word(r.status) + '</span> '
      + (r.dry_run ? '<span class="tag">dry</span>' : '') + '</td>'
      + '<td class="num hide-s">' + n(r.packages) + '</td>'
      + '<td class="num hide-s">' + n(r.images) + '</td>'
      + '<td class="num hide-s">' + dur(r.duration) + '</td>'
      + '<td><button data-run="' + esc(r.run_id) + '">Open</button></td></tr>').join('')
    + '</tbody></table></div>';
}

/* ------------------------------------------------------- view: monitor */
async function loadMonitor() {
  try {
    const r = await fetch('containers.json?_=' + Date.now());
    S.mon = r.ok ? await r.json() : { containers: [] };
  } catch (e) { S.mon = { containers: [] }; }
  const cts = S.mon.containers || [];
  if (!cts.some(c => String(c.id) === String(S.monSel))) S.monSel = cts.length ? cts[0].id : null;
  if (S.view === 'monitor') render();
}

function monAddr(c) {
  const port = n(S.mon && S.mon.ttyd_port) || 7681;
  return c.url ? c.url.replace(/\/+$/, '') + '/' : 'http://' + c.ip + ':' + port + '/';
}
function monTileHeight() { return n(P.monCols) === 1 ? '72vh' : '440px'; }

function monTools(cts) {
  const cols = n(P.monCols) || 2;
  return '<div class="tools">'
    + '<span class="lbl">' + cts.length + ' containers &middot; read '
    + esc(when(S.mon.generated)) + '</span>'
    + '<div class="seg" role="group" aria-label="Layout">'
    + '<button data-monmode="grid" aria-pressed="' + (P.monMode === 'grid') + '">Grid</button>'
    + '<button data-monmode="focus" aria-pressed="' + (P.monMode === 'focus') + '">Focus</button>'
    + '</div>'
    + (P.monMode === 'grid'
      ? '<div class="seg" role="group" aria-label="Columns">'
        + [1, 2, 3, 4].map(c => '<button data-moncols="' + c + '" aria-pressed="'
            + (cols === c) + '">' + c + '</button>').join('')
        + '</div>'
      : '')
    + '<button id="monreloadall">Reload all</button>'
    + '<button class="primary" id="monaddmissing" title="Install btop on every running '
    + 'container that is not on this list yet">Install on missing</button></div>';
}

function monTile(c) {
  const url = monAddr(c);
  return '<div class="montile"><div class="tilebar">'
    + '<span class="dot wait" data-dot="' + esc(c.id) + '"></span>'
    + '<b>' + esc(c.name) + '</b>'
    + '<span class="lbl">' + esc(c.id) + ' &middot; ' + esc(c.ip || c.url || '') + '</span>'
    + '<span class="spacer"></span>'
    + '<button class="ghost" data-monreload="' + esc(c.id) + '" title="Reload">&#8635;</button>'
    + '<button class="ghost" data-openurl="' + esc(url) + '" title="Open in a tab">&#8599;</button>'
    + '</div><div class="tilebody"><iframe data-frame="' + esc(c.id) + '" src="' + esc(url) + '" '
    + 'title="btop on ' + esc(c.name) + '"></iframe>'
    + '<div class="tiledown" data-down="' + esc(c.id) + '" hidden>'
    + '<p>Not answering on <code>' + esc(url) + '</code>.</p>'
    + '<button class="primary" data-installone="' + esc(c.id) + '" data-installname="'
    + esc(c.name) + '">Install btop here</button>'
    + '<span class="lbl" data-installstate="' + esc(c.id) + '"></span>'
    + '</div></div></div>';
}

function monMissingList() {
  const live = (S.state && S.state.guests) || [];
  const known = new Map((S.mon.containers || []).map(c => [String(c.id), c]));
  return live.filter(g => {
    if (g.type !== 'lxc' || g.status !== 'running') return false;
    const c = known.get(String(g.id));
    if (!c) return true;               // never provisioned
    return S.monDown && S.monDown.has(String(g.id));  // provisioned but not answering
  });
}

function monitor() {
  if (!S.mon) return '<div class="panel"><p class="empty">Loading the monitor&hellip;</p></div>';
  const cts = S.mon.containers || [];
  const missing = monMissingList();

  if (!cts.length) {
    return '<div class="panel empty-state"><h2>No live monitor yet</h2>'
      + '<p>Install btop + ttyd straight into a running container, or turn on '
      + '<b>Live btop monitor</b> in Settings so every weekly run keeps it fresh.</p>'
      + (missing.length
        ? '<div class="pick" style="justify-content:center">'
          + missing.map(g => '<button data-installone="' + esc(g.id) + '" data-installname="'
              + esc(g.name) + '">Install on ' + esc(g.name) + ' (' + esc(g.id) + ')</button>').join('')
          + '</div><p class="lbl" id="installempty" style="margin-top:14px"></p>'
        : '<p class="empty">No running containers were found to install it on.</p>')
      + '<div class="savebar" style="justify-content:center;border:0">'
      + '<button class="ghost" data-goto="settings">Open settings</button></div></div>';
  }

  const head = '<div class="viewhead"><div><h2>Live monitor</h2>'
    + '<p class="sub">btop inside every container, straight from the node.</p></div>'
    + monTools(cts) + '</div>';

  if (location.protocol === 'https:' && cts.some(c => monAddr(c).indexOf('http://') === 0)) {
    return head + '<div class="panel"><div class="note bad">This page is on HTTPS and the '
      + 'monitors are plain HTTP, so the browser blocks the frames. Open the dashboard over '
      + 'HTTP, or put each container behind the reverse proxy and give it a <code>url</code> '
      + 'in containers.json.</div></div>';
  }

  if (P.monMode === 'grid') {
    return head + '<div class="mongrid" id="mongrid">'
      + cts.map(monTile).join('') + '</div>';
  }

  const sel = cts.find(c => String(c.id) === String(S.monSel)) || cts[0];
  return head + '<div class="monwrap">'
    + '<aside class="monlist">'
    + cts.map(c => '<button data-mon="' + esc(c.id) + '" aria-current="'
        + (String(c.id) === String(sel.id)) + '">'
        + '<span class="dot wait" data-dot="' + esc(c.id) + '"></span>'
        + '<span class="who"><b>' + esc(c.name) + '</b><span>'
        + esc(c.id) + ' &middot; ' + esc(c.ip || c.url || '') + '</span></span></button>').join('')
    + (missing.length ? '<div class="lbl" style="padding:8px 10px 2px">not installed</div>'
      + missing.map(g => '<button class="dim" data-installone="' + esc(g.id)
          + '" data-installname="' + esc(g.name) + '">'
          + '<span class="dot"></span><span class="who"><b>' + esc(g.name) + '</b><span>'
          + esc(g.id) + ' &middot; install btop</span></span></button>').join('') : '')
    + '</aside>'
    + '<section class="monview"><div class="monbar">'
    + '<b id="monname">' + esc(sel.name) + '</b>'
    + '<span class="lbl" id="monaddr">' + esc(monAddr(sel)) + '</span>'
    + '<span class="spacer"></span>'
    + '<button class="ghost" data-monreload="' + esc(sel.id) + '">Reload</button>'
    + '<button class="ghost" id="monopen" data-openurl="' + esc(monAddr(sel)) + '">Open in a tab</button>'
    + '</div>'
    + '<iframe id="monframe" data-frame="' + esc(sel.id) + '" src="' + esc(monAddr(sel)) + '" '
    + 'title="btop on ' + esc(sel.name) + '"></iframe></section></div>';
}

function monMount() {
  const g = $('#mongrid');
  if (g) {
    g.style.setProperty('--cols', String(n(P.monCols) || 2));
    g.style.setProperty('--tileh', monTileHeight());
  }
  const f = $('#monframe');
  if (f) f.style.setProperty('--tileh', '72vh');
  probeAll();
  if (S.probeTimer) clearInterval(S.probeTimer);
  S.probeTimer = setInterval(probeAll, 30000);
}

async function probe(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 4000);
  try { await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: ac.signal }); return true; }
  catch (e) { return false; }
  finally { clearTimeout(t); }
}

function probeAll() {
  if (S.view !== 'monitor' || !S.mon) return;
  (S.mon.containers || []).forEach(async c => {
    const up = await probe(monAddr(c));
    if (up) S.monDown.delete(String(c.id)); else S.monDown.add(String(c.id));
    $$('[data-dot="' + c.id + '"]').forEach(d => { d.className = 'dot ' + (up ? 'ok' : 'error'); });
    const down = document.querySelector('[data-down="' + c.id + '"]');
    if (down) down.hidden = up;
  });
}

/* --------------------------------------------------------- monitor installs */
const installing = new Set();

function setInstallState(id, text) {
  document.querySelectorAll('[data-installstate="' + id + '"]').forEach(el => { el.textContent = text; });
  document.querySelectorAll('[data-installone="' + id + '"]').forEach(b => {
    b.disabled = !!text && text.indexOf('failed') === -1;
  });
}

async function installMonitor(ids, names) {
  ids = ids.filter(id => !installing.has(String(id)));
  if (!ids.length) return;
  ids.forEach(id => installing.add(String(id)));
  ids.forEach(id => setInstallState(id, 'Installing&hellip;'));
  const empty = $('#installempty');
  if (empty) empty.textContent = 'Installing on ' + (names || ids).join(', ') + '&hellip;';

  try {
    await api('/api/run', { method: 'POST',
      body: JSON.stringify({ mode: 'monitor', only: ids.map(String) }) });
  } catch (e) {
    ids.forEach(id => { installing.delete(String(id)); setInstallState(id, 'failed: ' + e.message); });
    return;
  }

  const poll = setInterval(async () => {
    let r;
    try { r = await (await fetch('/api/state')).json(); } catch (e) { return; }
    if (r.run && r.run.running) return;
    clearInterval(poll);
    ids.forEach(id => installing.delete(String(id)));
    S.state = r;
    await loadMonitor();
    if (S.view === 'monitor') { render(); probeAll(); }
  }, 2000);
}

function wireInstallClicks(t) {
  const one = t.closest('[data-installone]');
  if (one) {
    installMonitor([one.dataset.installone], [one.dataset.installname || one.dataset.installone]);
    return true;
  }
  if (t.closest('#monaddmissing')) {
    const missing = monMissingList();
    if (!missing.length) { alert('Every running container already has the monitor.'); return true; }
    installMonitor(missing.map(g => g.id), missing.map(g => g.name));
    return true;
  }
  return false;
}
const APPEARANCE = [
  ['width', 'Content width', 'Fill the window, or keep a centred column.',
   [['full', 'Full'], ['centered', 'Centered']]],
  ['text', 'Text size', 'Scales the whole interface.',
   [['sm', 'Small'], ['md', 'Normal'], ['lg', 'Large']]],
  ['density', 'Density', 'Compact tightens padding and corners.',
   [['cozy', 'Cozy'], ['compact', 'Compact']]],
  ['motion', 'Motion', 'Turn off if animation is distracting.',
   [['auto', 'On'], ['off', 'Reduced']]],
];
const ACCENT_PRESETS = ['#FFB224', '#3ECF8E', '#5AA9FF', '#B392FF',
                        '#FF6B57', '#FF7AC6', '#45D6E0', '#C9D3E0'];

const FIELDS = [
  ['UPDATE_HOST', 'Update the Proxmox node', 'apt-get update and full-upgrade on the host itself.'],
  ['UPDATE_GUESTS', 'Update the containers', 'Walk every LXC on this node.'],
  ['UPDATE_PACKAGES', 'Update OS packages', 'Inside the containers. Turn off to only touch Docker.'],
  ['UPDATE_DOCKER', 'Update compose stacks', 'docker compose pull, then up -d.'],
  ['BTOP_MONITOR', 'Live btop monitor', 'Installs btop + ttyd in each container and fills the Monitor tab. Unlike updates, this installs packages.'],
  ['SNAPSHOT_BEFORE_UPDATE', 'Snapshot before updating', 'Needs snapshot-capable storage and no bind mounts.'],
  ['INCLUDE_STOPPED', 'Include stopped containers', 'Start them, update them, then stop them again.'],
  ['DOCKER_PRUNE', 'Clean up old images', 'Removes dangling images after the pull.'],
  ['DOCKER_PRUNE_ALL', 'Aggressive image cleanup', 'Also deletes images no container uses. Frees more, redownloads more.'],
  ['DISCOVER_COMPOSE_FILES', 'Look for stray compose files', 'Reports compose files belonging to no running project.'],
  ['ADOPT_ORPHAN_STACKS', 'Start stray stacks too', 'Off on purpose: this would start stacks you deliberately stopped.'],
  ['REBOOT_HOST_IF_REQUIRED', 'Reboot the node when needed', 'Only after a kernel update, and unattended.'],
];
const NUMS = [
  ['SNAPSHOT_KEEP', 'Snapshots kept per container'],
  ['REPORT_RETENTION', 'Runs kept in this dashboard'],
  ['POST_START_WAIT', 'Seconds to wait after starting a container'],
  ['BTOP_PORT', 'btop monitor port (per container)'],
];
const TEXTS = [
  ['NTFY_URL', 'ntfy topic URL', 'Gets a one line summary after every run.'],
  ['NTFY_TOKEN', 'ntfy token', 'Only if your ntfy server needs one.'],
  ['WEBHOOK_URL', 'Webhook URL', 'Receives title, text and run_id as JSON.'],
];

function accentRow() {
  const hex = normHex(P.accent) || PREF_DEFAULTS.accent;
  return '<div class="set"><div class="txt"><label for="accentcolor">Accent colour</label>'
    + '<small>Any colour. Everything that uses it &mdash; text, borders, tints &mdash; is '
    + 'derived from this one value, and lightened automatically if it is too dark to read '
    + 'on black.</small></div>'
    + '<div class="ctl"><div class="accent">'
    + ACCENT_PRESETS.map(c => '<button class="swatch big" data-accentval="' + c + '" '
        + 'title="' + c + '" aria-label="' + c + '" aria-pressed="'
        + (c.toUpperCase() === hex) + '" style="background:' + c + '"></button>').join('')
    + '<input type="color" id="accentcolor" value="' + esc(hex) + '" aria-label="Pick a colour">'
    + '<input type="text" id="accenthex" class="hex m" value="' + esc(hex)
    + '" spellcheck="false" maxlength="7" aria-label="Accent hex value">'
    + '</div></div></div>';
}

function appearancePanel() {
  return '<div class="panel"><h2>Appearance</h2>'
    + '<p class="sub" style="margin:0 0 6px">Kept in this browser only, nothing is written '
    + 'to the node.</p>'
    + APPEARANCE.map(a => '<div class="set"><div class="txt"><label>' + esc(a[1])
      + '</label><small>' + esc(a[2]) + '</small></div><div class="ctl"><div class="seg">'
      + a[3].map(o => '<button data-pref="' + a[0] + '" data-val="' + o[0] + '" aria-pressed="'
          + (P[a[0]] === o[0]) + '">' + esc(o[1]) + '</button>').join('')
      + '</div></div></div>').join('')
    + accentRow()
    + '<div class="savebar"><button class="ghost" id="prefreset">Reset to defaults</button>'
    + '<span class="lbl">monitor layout and console size are remembered too</span></div></div>';
}

function settings() {
  const head = '<div class="viewhead"><div><h2>Settings</h2>'
    + '<p class="sub">How the node looks here, and what the weekly run does.</p></div></div>';

  if (!S.api) return head + appearancePanel()
    + '<div class="panel"><h2>Run settings</h2><p class="empty">'
    + 'This page cannot reach the backend, so the run settings cannot be edited here. '
    + 'Edit <code>/etc/pve-updater/pve-updater.conf</code> over SSH.</p></div>';

  if (!S.conf) { loadConf(); return head + appearancePanel()
    + '<div class="panel"><p class="empty">Loading run settings&hellip;</p></div>'; }

  const c = S.confDraft;
  const guests = ((S.state && S.state.guests) || []).filter(g => g.type === 'lxc');
  const excluded = (c.EXCLUDE_CTIDS || []).map(String);

  return head + appearancePanel()

    + '<div class="panel"><h2>What the weekly run does</h2>'
    + '<p class="sub" style="margin:0 0 6px">Written to '
    + '<code>/etc/pve-updater/pve-updater.conf</code>. Your comments in that file are kept.</p>'
    + FIELDS.map(f => '<div class="set"><div class="txt"><label for="f-' + f[0] + '">'
      + esc(f[1]) + '</label><small>' + esc(f[2]) + '</small></div>'
      + '<div class="ctl"><button class="sw" role="switch" id="f-' + f[0] + '" data-bool="' + f[0]
      + '" aria-checked="' + !!c[f[0]] + '" aria-label="' + esc(f[1]) + '"></button></div></div>').join('')
    + '</div>'

    + '<div class="panel"><h2>Containers to leave alone</h2>'
    + '<p class="sub" style="margin:0">Tap one to skip it. Useful for anything you do not '
    + 'want restarting at three in the morning.</p><div class="pick">'
    + (guests.map(g => '<button data-excl="' + esc(g.id) + '" aria-pressed="'
        + (excluded.indexOf(g.id) >= 0) + '">' + esc(g.id) + ' ' + esc(g.name) + '</button>').join('')
       || '<span class="empty">No containers found.</span>')
    + '</div></div>'

    + '<div class="panel"><h2>Numbers</h2>'
    + NUMS.map(f => '<div class="set"><div class="txt"><label for="f-' + f[0] + '">'
      + esc(f[1]) + '</label></div><div class="ctl w"><input type="number" id="f-' + f[0]
      + '" data-num="' + f[0] + '" min="0" max="9999" value="' + n(c[f[0]]) + '"></div></div>').join('')
    + '</div>'

    + '<div class="panel"><h2>Tell me when it is done</h2>'
    + TEXTS.map(f => '<div class="set"><div class="txt"><label for="f-' + f[0] + '">'
      + esc(f[1]) + '</label><small>' + esc(f[2]) + '</small></div>'
      + '<div class="ctl" style="width:min(340px,100%)"><input type="text" id="f-' + f[0]
      + '" data-text="' + f[0] + '" value="' + esc(c[f[0]] || '')
      + '" placeholder="leave empty for none"></div></div>').join('')
    + '<div class="savebar"><button class="primary" id="save"' + (S.saving ? ' disabled' : '') + '>'
    + (S.saving ? 'Saving&hellip;' : 'Save settings') + '</button>'
    + '<button class="ghost" id="revert">Undo changes</button>'
    + '<span id="savemsg" class="lbl"></span></div></div>';
}

async function loadConf() {
  try {
    const r = await api('/api/config');
    S.conf = r.values;
    S.confDraft = JSON.parse(JSON.stringify(r.values));
    render();
  } catch (e) {
    S.conf = null;
    if (e.message !== 'unauthorised' && S.view === 'settings') {
      const m = $('#main');
      if (m) m.insertAdjacentHTML('beforeend',
        '<div class="panel"><p class="empty">' + esc(e.message) + '</p></div>');
    }
  }
}

async function saveConf() {
  S.saving = true; render();
  let msg = 'Saved';
  try {
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify({ values: S.confDraft }) });
    S.conf = r.values;
    S.confDraft = JSON.parse(JSON.stringify(r.values));
  } catch (e) { msg = e.message; }
  S.saving = false; render();
  const m = $('#savemsg'); if (m) m.textContent = msg;
}

/* -------------------------------------------------------------------- runs */
function runMenu() {
  return '<div class="menu-pop">'
    + '<button data-mode="full">Update everything<small>Node, containers and compose stacks</small></button>'
    + '<button data-mode="dry">Dry run<small>Show what would change, change nothing</small></button>'
    + '<button data-mode="inventory">Discover only<small>Map the services, fastest option</small></button>'
    + '</div>';
}

async function startRun(mode, only) {
  try {
    await api('/api/run', { method: 'POST', body: JSON.stringify({ mode: mode, only: only || [] }) });
    S.logOffset = 0; S.logText = '';
    startConsole();
  } catch (e) {
    if (e.message !== 'unauthorised') alert(e.message);
  }
}

function startConsole() {
  if (S.polling) clearInterval(S.polling);
  drawConsole(true, null);
  S.polling = setInterval(pollLog, 1000);
  pollLog();
}

async function pollLog() {
  let r;
  try { r = await (await fetch('/api/run/log?from=' + S.logOffset)).json(); }
  catch (e) { return; }
  if (r.data) { S.logText += r.data; S.logOffset = r.offset; }
  drawConsole(r.run.running, r.run.exit);
  if (!r.run.running) {
    clearInterval(S.polling); S.polling = null;
    try {
      S.index = await (await fetch('reports/index.json?_=' + Date.now())).json();
      if ((S.index.runs || []).length) await loadRun(S.index.runs[0].run_id);
      S.state = await (await fetch('/api/state')).json();
    } catch (e) {}
    // never repaint a manual view from the background: it would reload the frames
    if (viewDef(S.view).manual) { renderTabs(); renderPulse(); }
    else render();
  }
}

/* How far along a run is, read straight out of the log the updater prints. */
function runProgress(running) {
  const txt = S.logText || '';
  const marks = txt.match(/===\s+(host:\s*\S+|ct\s+\d+\s+\([^)]*\))/g) || [];
  const done = marks.length;
  const finished = /===\s+run\s+\S+\s+finished/.test(txt);

  let total = 0;
  const only = txt.match(/--only\s+(\S+)/);
  const hostOnly = /--host-only/.test(txt);
  if (only) total = only[1].split(',').filter(Boolean).length;
  else if (hostOnly) total = 1;
  else {
    const lxc = ((S.state && S.state.guests) || []).filter(g => g.type === 'lxc').length;
    if (lxc) total = lxc + 1;
  }

  let label = 'Update in progress';
  if (done) {
    const m = marks[done - 1];
    const ct = m.match(/ct\s+(\d+)\s+\(([^)]*)\)/);
    label = ct ? 'Updating ' + ct[2] + ' (' + ct[1] + ')' : 'Updating the node';
  }

  let pct, indet = false;
  if (!running || finished) pct = 100;
  else if (total) pct = Math.max(3, Math.min(97, Math.round(((done - 0.4) / total) * 100)));
  else { pct = 40; indet = true; }

  return { pct: pct, indet: indet, done: done, total: total, label: label };
}

function drawConsole(running, exit) {
  S.live = { running: running, exit: exit };
  const mini = P.logMode === 'mini';
  const p = runProgress(running);
  const verdict = exit === 0 ? 'Finished cleanly'
    : exit === 1 ? 'Finished, something wants a look'
    : exit == null ? 'Finished' : 'Finished with errors, exit ' + exit;
  const tone = running ? '' : (exit === 0 ? ' ok' : exit === 1 ? ' warn' : ' bad');

  const old = $('#logpre');
  const stick = !old || (old.scrollHeight - old.scrollTop - old.clientHeight) < 60;
  const h = Math.max(90, n(P.logHeight) || 280);

  $('#console').innerHTML = '<div class="console ' + (mini ? 'mini' : 'open') + '">'
    + (mini ? '' : '<div class="drag" id="logdrag" title="Drag to resize"></div>')
    + '<div class="bar">'
    + (running ? '<span class="spin"></span>' : '')
    + '<b>' + esc(running ? p.label : verdict) + '</b>'
    + (running && p.total
      ? '<span class="lbl hide-s">' + p.done + ' of ' + p.total + '</span>' : '')
    + (mini && running ? '<span class="lbl">' + p.pct + '%</span>' : '')
    + '<span class="spacer"></span>'
    + '<button class="ghost icon" id="logmode" title="' + (mini ? 'Expand' : 'Send to the side')
    + '" aria-label="' + (mini ? 'Expand' : 'Send to the side') + '">'
    + (mini ? '&#9650;' : '&#9660;') + '</button>'
    + (running ? '<button class="ghost" id="stoprun">Stop</button>' : '')
    + '<button class="ghost" id="closeconsole">Close</button>'
    + '</div>'
    + '<div class="prog' + tone + (p.indet ? ' indet' : '') + '">'
    + '<i style="width:' + p.pct + '%"></i></div>'
    + (mini ? '' : '<pre id="logpre" style="height:' + h + 'px">'
        + (esc(S.logText) || 'waiting for output&hellip;') + '</pre>')
    + '</div>';

  document.body.style.paddingBottom = mini ? '92px' : (h + 92) + 'px';

  const pre = $('#logpre');
  if (pre && stick) pre.scrollTop = pre.scrollHeight;
  wireConsole();
}

function closeConsole() {
  $('#console').innerHTML = '';
  document.body.style.paddingBottom = '';
}

function wireConsole() {
  const d = $('#logdrag');
  if (!d) return;
  const start = (y0) => {
    const h0 = Math.max(90, n(P.logHeight) || 280);
    const move = y => {
      const h = Math.max(90, Math.min(window.innerHeight - 160, h0 + (y0 - y)));
      P.logHeight = h;
      const pre = $('#logpre');
      if (pre) pre.style.height = h + 'px';
      document.body.style.paddingBottom = (h + 92) + 'px';
    };
    const onMove = ev => move(ev.touches ? ev.touches[0].clientY : ev.clientY);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      savePrefs();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  };
  d.onmousedown = e => { e.preventDefault(); start(e.clientY); };
  d.ontouchstart = e => { start(e.touches[0].clientY); };
}

/* --------------------------------------------------------------------- key */
function askKey() {
  $('#modal').innerHTML = '<div class="veil"><div class="modal">'
    + '<h2>Access key needed</h2>'
    + '<p>Saving settings and starting runs happens as root on the node, so it sits behind a key. '
    + 'Read it on the node with <code>cat /etc/pve-updater/web.token</code>.</p>'
    + '<input type="text" id="tok" placeholder="paste the key" autocomplete="off">'
    + '<div class="savebar" style="border:0;padding:0;margin-top:16px">'
    + '<button class="primary" id="savetok">Save key</button>'
    + '<button class="ghost" id="canceltok">Cancel</button>'
    + (store.get() ? '<button class="ghost" id="forgettok">Forget stored key</button>' : '')
    + '</div></div></div>';
  setTimeout(() => { const el = $('#tok'); if (el) el.focus(); }, 30);
}

/* ------------------------------------------------------------------ render */
function render() {
  renderTabs();
  renderPulse();
  const v = viewDef(S.view);
  $('#main').innerHTML = v.view();
  $('#runmenu').innerHTML = S.menuOpen ? runMenu() : '';
  $('#runmenu').hidden = !S.menuOpen;
  if (v.mount) v.mount();
  wire();
}

function wire() {
  const q = $('#q');
  if (q) q.oninput = e => {
    S.q = e.target.value;
    const r = mapBody(mapRows());
    const b = $('#mapbody'), c = $('#mapcount');
    if (b) b.innerHTML = r.body;
    if (c) c.textContent = r.count;
  };
  const pq = $('#pkgq');
  if (pq) pq.oninput = e => {
    S.pkgq = e.target.value;
    const t = (S.report.targets || []).find(x => x.id === S.sel);
    const q2 = S.pkgq.trim().toLowerCase();
    const list = ((t.packages && t.packages.list) || [])
      .filter(p => p.name.toLowerCase().indexOf(q2) >= 0);
    const b = $('#pkgbody'); if (b) b.innerHTML = pkgRows(list);
  };
  const ac = $('#accentcolor');
  if (ac) ac.oninput = e => {
    if (setAccent(e.target.value)) {
      const h = $('#accenthex'); if (h) h.value = P.accent;
      $$('[data-accentval]').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.accentval.toUpperCase() === P.accent)));
    }
  };
  const ah = $('#accenthex');
  if (ah) ah.onchange = e => {
    if (setAccent(e.target.value)) {
      e.target.value = P.accent;
      if (ac) ac.value = P.accent;
      $$('[data-accentval]').forEach(b =>
        b.setAttribute('aria-pressed', String(b.dataset.accentval.toUpperCase() === P.accent)));
    } else { e.target.value = normHex(P.accent) || PREF_DEFAULTS.accent; }
  };
  $$('[data-num]').forEach(i => {
    i.onchange = e => { S.confDraft[e.target.dataset.num] = parseInt(e.target.value || '0', 10); };
  });
  $$('[data-text]').forEach(i => {
    i.onchange = e => { S.confDraft[e.target.dataset.text] = e.target.value.trim(); };
  });
}

document.addEventListener('click', async e => {
  const t = e.target;

  const tab = t.closest('nav button');
  if (tab) return setView(tab.dataset.view);

  const goto = t.closest('[data-goto]');
  if (goto) return setView(goto.dataset.goto);

  if (t.closest('#runbtn')) { S.menuOpen = !S.menuOpen; return render(); }

  const mode = t.closest('[data-mode]');
  if (mode) { S.menuOpen = false; render(); return startRun(mode.dataset.mode); }
  if (!t.closest('.menu') && S.menuOpen) { S.menuOpen = false; render(); }

  const one = t.closest('[data-runone]');
  if (one) return startRun('full', [one.dataset.runone]);

  const card = t.closest('[data-card]');
  if (card) { S.sel = card.dataset.card; S.pkgq = ''; return render(); }

  /* ---- monitor: mutate the DOM, never repaint, or the frames restart ---- */
  if (wireInstallClicks(t)) return;

  const mm = t.closest('[data-monmode]');
  if (mm) { P.monMode = mm.dataset.monmode; savePrefs(); return render(); }

  const mc = t.closest('[data-moncols]');
  if (mc) {
    P.monCols = n(mc.dataset.moncols) || 2; savePrefs();
    const g = $('#mongrid');
    if (g) {
      g.style.setProperty('--cols', String(P.monCols));
      g.style.setProperty('--tileh', monTileHeight());
    }
    $$('[data-moncols]').forEach(b =>
      b.setAttribute('aria-pressed', String(n(b.dataset.moncols) === P.monCols)));
    return;
  }

  const ms = t.closest('[data-mon]');
  if (ms) {
    const c = ((S.mon && S.mon.containers) || []).find(x => String(x.id) === ms.dataset.mon);
    if (!c) return;
    S.monSel = c.id;
    const f = $('#monframe');
    if (f) { f.src = monAddr(c); f.dataset.frame = c.id; }
    const nm = $('#monname'); if (nm) nm.textContent = c.name;
    const ad = $('#monaddr'); if (ad) ad.textContent = monAddr(c);
    const op = $('#monopen'); if (op) op.dataset.openurl = monAddr(c);
    $$('[data-mon]').forEach(b =>
      b.setAttribute('aria-current', String(b.dataset.mon === String(c.id))));
    return;
  }

  const mr = t.closest('[data-monreload]');
  if (mr) {
    const f = document.querySelector('[data-frame="' + mr.dataset.monreload + '"]');
    if (f) f.src = f.src;
    return;
  }
  if (t.closest('#monreloadall')) { $$('[data-frame]').forEach(f => { f.src = f.src; }); return; }

  const openurl = t.closest('[data-openurl]');
  if (openurl) { window.open(openurl.dataset.openurl, '_blank', 'noopener'); return; }

  const open = t.closest('[data-run]');
  if (open) { await loadRun(open.dataset.run); return setView('overview'); }

  /* ------------------------------------------------------------ settings */
  const av = t.closest('[data-accentval]');
  if (av) { setAccent(av.dataset.accentval); return render(); }

  const pref = t.closest('[data-pref]');
  if (pref) { P[pref.dataset.pref] = pref.dataset.val; savePrefs(); return render(); }
  if (t.closest('#prefreset')) { P = Object.assign({}, PREF_DEFAULTS); savePrefs(); return render(); }

  const bool = t.closest('[data-bool]');
  if (bool) {
    const k = bool.dataset.bool;
    S.confDraft[k] = !S.confDraft[k];
    bool.setAttribute('aria-checked', String(S.confDraft[k]));
    return;
  }
  const ex = t.closest('[data-excl]');
  if (ex) {
    const id = ex.dataset.excl;
    const list = (S.confDraft.EXCLUDE_CTIDS || []).map(String);
    S.confDraft.EXCLUDE_CTIDS = list.indexOf(id) >= 0
      ? list.filter(x => x !== id) : list.concat([id]);
    ex.setAttribute('aria-pressed', String(S.confDraft.EXCLUDE_CTIDS.indexOf(id) >= 0));
    return;
  }
  if (t.closest('#save')) return saveConf();
  if (t.closest('#revert')) { S.confDraft = JSON.parse(JSON.stringify(S.conf)); return render(); }

  if (t.closest('#keybtn')) return askKey();
  if (t.closest('#savetok')) {
    store.set($('#tok').value.trim());
    $('#modal').innerHTML = '';
    S.conf = null;
    return render();
  }
  if (t.closest('#canceltok')) { $('#modal').innerHTML = ''; return; }
  if (t.closest('#forgettok')) { store.clear(); $('#modal').innerHTML = ''; return render(); }

  if (t.closest('#logmode')) {
    P.logMode = P.logMode === 'mini' ? 'open' : 'mini';
    savePrefs();
    return drawConsole(S.live.running, S.live.exit);
  }
  if (t.closest('#closeconsole')) return closeConsole();
  if (t.closest('#stoprun')) {
    try { await api('/api/run/stop', { method: 'POST' }); }
    catch (err) { if (err.message !== 'unauthorised') alert(err.message); }
    return;
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { $('#modal').innerHTML = ''; S.menuOpen = false; render(); }
});

window.addEventListener('hashchange', () => {
  const h = (location.hash || '').replace('#', '');
  if (h && h !== S.view && VIEWS.some(v => v.id === h)) setView(h);
});

boot();
