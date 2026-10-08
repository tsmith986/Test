// Admin single-page app. Plain JS, no build step.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
let view = $('#view');

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const today = () => new Date().toISOString().slice(0, 10);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error('Please log in');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${bad ? ' bad' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 5000 : 2500);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    prompt('Copy this:', text);
  }
}

// ---------- Auth ----------
function showLogin() {
  $('#shell').hidden = true;
  $('#login').hidden = false;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/login', { method: 'POST', body: { password: e.target.password.value } });
    e.target.reset();
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

async function start() {
  const me = await api('/me');
  if (!me.authed) return showLogin();
  $('#login').hidden = true;
  $('#shell').hidden = false;
  route();
}

async function refreshBadge() {
  try {
    const s = await api('/stats');
    const n = s.unreadSubmissions + s.openRequests;
    $('#inbox-badge').hidden = !n;
    $('#inbox-badge').textContent = n;
  } catch {}
}

// ---------- Router ----------
let cleanup = null;
const routes = { dashboard, find, leads, sites, site: siteEditor, inbox, billing, settings };

async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  const [name = 'dashboard', arg] = location.hash.replace(/^#\/?/, '').split('/');
  const fn = routes[name] || dashboard;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name === 'site' ? 'sites' : name)));
  // Fresh element per render so per-view event listeners never pile up.
  const fresh = view.cloneNode(false);
  view.replaceWith(fresh);
  view = fresh;
  view.innerHTML = '<p class="muted">Loading…</p>';
  refreshBadge();
  try {
    await fn(arg);
  } catch (err) {
    view.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="error">${esc(err.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', route);

// ---------- Dashboard ----------
async function dashboard() {
  const [s, leadList] = await Promise.all([api('/stats'), api('/leads')]);
  const due = leadList.filter((l) => l.followUpAt && l.followUpAt <= today() && !['won', 'lost'].includes(l.status));
  view.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><p class="muted">Find businesses without a website, build them one, and get paid monthly.</p></div>
      <a class="btn" href="#/find">🗺️ Find leads</a></div>
    <div class="stats">
      ${stat('Monthly recurring', money(s.mrr))}
      ${stat('Collected all-time', money(s.collected))}
      ${stat('Paying clients', s.paying)}
      ${stat('Live sites', `${s.live} <span class="muted small">/ ${s.sites}</span>`)}
      ${stat('Leads', s.leads)}
      ${stat('Inbox', s.unreadSubmissions + s.openRequests)}
    </div>
    <div class="grid" style="margin-top:16px">
      <div class="card"><h2>Follow-ups due</h2>${due.length ? `<table>${due.map((l) => `<tr><td><b>${esc(l.name)}</b><div class="muted small">${esc(l.category || '')}</div></td><td>${l.phone ? `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>` : ''}</td><td><span class="pill ${esc(l.status)}">${esc(l.status)}</span></td></tr>`).join('')}</table>` : '<p class="muted">Nothing due today.</p>'}
        <p><a href="#/leads">Open pipeline →</a></p></div>
      <div class="card"><h2>Pipeline</h2>${['new', 'contacted', 'building', 'pitched', 'won', 'lost'].map((k) => `<div class="row spread"><span class="pill ${k}">${k}</span><b>${s.leadsByStatus[k] || 0}</b></div>`).join('<div style="height:6px"></div>')}</div>
      <div class="card"><h2>How it works</h2><ol class="muted" style="padding-left:18px;margin:0">
        <li><b>Find</b>: open the map and scan a neighborhood for businesses with no website.</li>
        <li><b>Build</b>: turn a lead into a site, add photos, and let AI write the copy.</li>
        <li><b>Pitch</b>: publish it and show the owner their new site.</li>
        <li><b>Get paid</b>: send the owner their portal link to pay the build fee + monthly plan.</li></ol></div>
    </div>`;
}
const stat = (label, value) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;

// ---------- Lead finder (OpenStreetMap / Overpass) ----------
const CATEGORY_PRESETS = {
  all: 'All local businesses',
  food: 'Food & drink',
  beauty: 'Beauty & hair',
  health: 'Health & wellness',
  trades: 'Trades & repair',
  auto: 'Auto',
  retail: 'Shops & retail',
  pro: 'Professional services',
};

function overpassQuery(bbox, preset) {
  const b = bbox; // south,west,north,east
  const sets = {
    food: [`nwr["name"]["amenity"~"^(restaurant|cafe|bar|pub|fast_food|ice_cream|food_court)$"](${b});`, `nwr["name"]["shop"~"^(bakery|butcher|deli|confectionery|pastry|coffee|tea|wine|alcohol|greengrocer|seafood|cheese)$"](${b});`],
    beauty: [`nwr["name"]["shop"~"^(hairdresser|beauty|cosmetics|massage|tattoo|nail_salon|barber)$"](${b});`, `nwr["name"]["amenity"="spa"](${b});`],
    health: [`nwr["name"]["amenity"~"^(dentist|doctors|clinic|veterinary|pharmacy)$"](${b});`, `nwr["name"]["healthcare"](${b});`, `nwr["name"]["leisure"~"^(fitness_centre|sports_centre|dance)$"](${b});`, `nwr["name"]["shop"~"^(optician|hearing_aids|massage)$"](${b});`],
    trades: [`nwr["name"]["craft"](${b});`, `nwr["name"]["shop"~"^(hardware|doityourself|locksmith|appliance|tailor|shoe_repair|dry_cleaning|laundry)$"](${b});`],
    auto: [`nwr["name"]["shop"~"^(car_repair|car|tyres|car_parts|motorcycle)$"](${b});`, `nwr["name"]["amenity"~"^(car_wash|driving_school|car_rental)$"](${b});`],
    retail: [`nwr["name"]["shop"]["shop"!~"^(supermarket|convenience|kiosk|vacant|chemist|mall|department_store)$"](${b});`],
    pro: [`nwr["name"]["office"~"^(lawyer|accountant|estate_agent|insurance|architect|tax_advisor|financial|consulting|it)$"](${b});`],
  };
  const parts = preset === 'all' ? Object.values(sets).flat() : sets[preset];
  return `[out:json][timeout:30];(${parts.join('')});out center tags 500;`;
}

const humanize = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function toLead(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const address = [street, t['addr:city'], t['addr:postcode']].filter(Boolean).join(', ');
  const website = t.website || t['contact:website'] || t.url || '';
  const instagram = t['contact:instagram'] || t.instagram || '';
  const facebook = t['contact:facebook'] || t.facebook || '';
  return {
    osmId: `${el.type}/${el.id}`,
    name: t.name,
    category: humanize(t.shop || t.amenity || t.craft || t.office || t.healthcare || t.leisure || t.tourism || ''),
    lat,
    lon,
    address,
    phone: t.phone || t['contact:phone'] || '',
    email: t.email || t['contact:email'] || '',
    website,
    instagram,
    facebook,
    openingHours: t.opening_hours || '',
    chain: Boolean(t.brand || t['brand:wikidata']),
    kind: website ? 'has' : instagram || facebook ? 'social' : 'none',
  };
}

async function find() {
  const savedLeads = await api('/leads');
  const saved = new Set(savedLeads.map((l) => l.osmId).filter(Boolean));
  const last = JSON.parse(localStorageGet('pd-map') || 'null') || { lat: 40.7128, lon: -74.006, zoom: 15 };

  view.innerHTML = `
    <div class="page-head"><div><h1>Find leads</h1><p class="muted small">Business data from OpenStreetMap. Zoom into a neighborhood and press <b>Scan this area</b>.</p></div></div>
    <div class="card" style="margin-bottom:12px"><form id="finder-form" class="row">
      <input name="q" placeholder="Search a city, neighborhood or address" style="flex:1;min-width:200px">
      <button class="btn secondary" type="submit">Go</button>
      <button class="btn secondary" type="button" id="locate">📍 Near me</button>
      <select name="preset" style="width:auto">${Object.entries(CATEGORY_PRESETS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <select name="show" style="width:auto">
        <option value="none">No website</option><option value="social">Only social media</option><option value="nowebsite">No website + social only</option><option value="all">Everything</option>
      </select>
      <label class="check"><input type="checkbox" name="hideChains" checked> Hide chains</label>
      <button class="btn" type="button" id="scan">Scan this area</button>
    </form></div>
    <div class="finder">
      <div id="map"></div>
      <div class="results" id="results"><div class="empty">Results show up here.<br><span class="small">🔴 no website · 🟣 social media only · ⚪ has a website</span></div></div>
    </div>`;

  const map = L.map('map').setView([last.lat, last.lon], last.zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  map.on('moveend', () => {
    const c = map.getCenter();
    localStorageSet('pd-map', JSON.stringify({ lat: c.lat, lon: c.lng, zoom: map.getZoom() }));
  });
  cleanup = () => map.remove();

  const form = $('#finder-form');
  let results = [];
  const markers = new Map();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    if (!q) return;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
      const [hit] = await r.json();
      if (!hit) return toast('Place not found', true);
      if (hit.boundingbox) {
        const [s, n, w, e2] = hit.boundingbox.map(Number);
        map.fitBounds([[s, w], [n, e2]], { maxZoom: 16 });
      } else map.setView([hit.lat, hit.lon], 15);
    } catch {
      toast('Search failed', true);
    }
  });

  $('#locate').addEventListener('click', () => {
    navigator.geolocation?.getCurrentPosition(
      (p) => map.setView([p.coords.latitude, p.coords.longitude], 16),
      () => toast('Could not get your location', true),
    );
  });

  const render = () => {
    const show = form.show.value;
    const hideChains = form.hideChains.checked;
    const list = results.filter((r) => {
      if (hideChains && r.chain) return false;
      if (show === 'none') return r.kind === 'none';
      if (show === 'social') return r.kind === 'social';
      if (show === 'nowebsite') return r.kind !== 'has';
      return true;
    });
    layer.clearLayers();
    markers.clear();
    const color = { none: '#dc2626', social: '#9333ea', has: '#9ca3af' };
    for (const r of list) {
      const m = L.circleMarker([r.lat, r.lon], { radius: 8, color: '#fff', weight: 2, fillColor: color[r.kind], fillOpacity: 0.95 })
        .bindPopup(popupHtml(r))
        .addTo(layer);
      m.on('popupopen', () => bindLeadButtons(m.getPopup().getElement(), r));
      markers.set(r.osmId, m);
    }
    const counts = { none: 0, social: 0, has: 0 };
    results.forEach((r) => (!hideChains || !r.chain) && counts[r.kind]++);
    $('#results').innerHTML = `
      <div class="muted small">${list.length} shown · <span class="dot none"></span>${counts.none} no website · <span class="dot social"></span>${counts.social} social only · <span class="dot has"></span>${counts.has} with website</div>
      ${list.map((r) => `<div class="result" data-id="${esc(r.osmId)}"><div class="name"><span class="dot ${r.kind}"></span>${esc(r.name)} ${saved.has(r.osmId) ? '<span class="pill good">saved</span>' : ''}</div>
        <div class="muted small">${esc(r.category)}${r.address ? ` · ${esc(r.address)}` : ''}</div>
        ${r.phone ? `<div class="small">📞 ${esc(r.phone)}</div>` : ''}</div>`).join('') || '<div class="empty">No matches here. Try another area or filter.</div>'}`;
  };

  function popupHtml(r) {
    return `<b>${esc(r.name)}</b><br><span class="muted">${esc(r.category)}</span>
      ${r.address ? `<br>${esc(r.address)}` : ''}${r.phone ? `<br>📞 <a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : ''}
      ${r.website ? `<br>🌐 <a href="${esc(/^https?:/.test(r.website) ? r.website : `https://${r.website}`)}" target="_blank" rel="noopener">website</a>` : ''}
      ${r.instagram ? `<br>📷 ${esc(r.instagram)}` : ''}${r.facebook ? `<br>👍 ${esc(r.facebook)}` : ''}
      ${r.openingHours ? `<br><span class="small">🕒 ${esc(r.openingHours)}</span>` : ''}
      <div class="row" style="margin-top:8px">${saved.has(r.osmId) ? '<span class="pill good">Saved</span>' : '<button class="btn sm secondary" data-act="save">Save lead</button>'}
      <button class="btn sm" data-act="build">Build site</button></div>`;
  }

  function bindLeadButtons(el, r) {
    $$('[data-act]', el).forEach((btn) =>
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const lead = await api('/leads', { method: 'POST', body: r });
          saved.add(r.osmId);
          if (btn.dataset.act === 'build') {
            const site = await api(`/leads/${lead.id}/build`, { method: 'POST' });
            location.hash = `#/site/${site.id}`;
          } else {
            toast(lead.duplicate ? 'Already saved' : 'Lead saved');
            render();
          }
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      }),
    );
  }

  $('#results').addEventListener('click', (e) => {
    const card = e.target.closest('.result');
    if (!card) return;
    const m = markers.get(card.dataset.id);
    if (m) {
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 17));
      m.openPopup();
    }
  });

  $('#scan').addEventListener('click', async () => {
    if (map.getZoom() < 13) return toast('Zoom in closer first (neighborhood level)', true);
    const b = map.getBounds();
    const bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((n) => n.toFixed(5)).join(',');
    const btn = $('#scan');
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: new URLSearchParams({ data: overpassQuery(bbox, form.preset.value) }),
      });
      if (!res.ok) throw new Error(res.status === 429 ? 'Map server is busy, wait a few seconds and retry.' : `Map server error ${res.status}`);
      const data = await res.json();
      const seen = new Set();
      results = data.elements
        .map(toLead)
        .filter((r) => r.name && r.lat && !seen.has(r.osmId) && seen.add(r.osmId))
        .sort((a, b) => ({ none: 0, social: 1, has: 2 })[a.kind] - ({ none: 0, social: 1, has: 2 })[b.kind]);
      render();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Scan this area';
    }
  });
  form.show.addEventListener('change', render);
  form.hideChains.addEventListener('change', render);
}

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// ---------- Leads pipeline ----------
const STATUSES = ['new', 'contacted', 'building', 'pitched', 'won', 'lost'];

async function leads() {
  const [list, siteList] = await Promise.all([api('/leads'), api('/sites')]);
  const siteByLead = Object.fromEntries(siteList.filter((s) => s.leadId).map((s) => [s.leadId, s]));
  view.innerHTML = `
    <div class="page-head"><div><h1>Leads</h1><p class="muted">Drag cards between columns. Click a card for details.</p></div>
      <div class="row"><input id="lead-search" placeholder="Filter…" style="width:200px"><button class="btn secondary" id="add-lead">+ Add manually</button></div></div>
    <div class="kanban" id="kanban">${STATUSES.map((s) => `<div class="col" data-status="${s}"><h3><span class="pill ${s}">${s}</span><span class="muted" data-count></span></h3></div>`).join('')}</div>
    <dialog id="lead-dialog" class="card" style="max-width:560px;width:calc(100% - 32px)"></dialog>`;

  const draw = () => {
    const q = $('#lead-search').value.toLowerCase();
    for (const col of $$('#kanban .col')) {
      const items = list.filter((l) => (l.status || 'new') === col.dataset.status && (!q || `${l.name} ${l.category} ${l.address}`.toLowerCase().includes(q)));
      $$('.lead-card', col).forEach((c) => c.remove());
      $('[data-count]', col).textContent = items.length;
      col.insertAdjacentHTML('beforeend', items.map((l) => `
        <div class="lead-card ${l.followUpAt && l.followUpAt <= today() && !['won', 'lost'].includes(l.status) ? 'due' : ''}" draggable="true" data-id="${l.id}">
          <b>${esc(l.name)}</b><span class="muted small">${esc(l.category || '')}</span>
          ${l.phone ? `<span class="small">📞 ${esc(l.phone)}</span>` : ''}
          ${l.followUpAt ? `<span class="small">⏰ ${esc(l.followUpAt)}</span>` : ''}
          ${siteByLead[l.id] ? `<span class="small">🌐 ${siteByLead[l.id].published ? 'site live' : 'site draft'}</span>` : ''}
        </div>`).join(''));
    }
  };
  draw();
  $('#lead-search').addEventListener('input', draw);

  const kanban = $('#kanban');
  kanban.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', e.target.closest('.lead-card')?.dataset.id || ''));
  kanban.addEventListener('dragover', (e) => {
    const col = e.target.closest('.col');
    if (!col) return;
    e.preventDefault();
    $$('.col', kanban).forEach((c) => c.classList.toggle('drop', c === col));
  });
  kanban.addEventListener('drop', async (e) => {
    const col = e.target.closest('.col');
    $$('.col', kanban).forEach((c) => c.classList.remove('drop'));
    const id = e.dataTransfer.getData('text/plain');
    const lead = list.find((l) => l.id === id);
    if (!col || !lead || lead.status === col.dataset.status) return;
    lead.status = col.dataset.status;
    draw();
    await api(`/leads/${id}`, { method: 'PATCH', body: { status: lead.status } }).catch((err) => toast(err.message, true));
  });
  kanban.addEventListener('click', (e) => {
    const card = e.target.closest('.lead-card');
    if (card) openLead(list.find((l) => l.id === card.dataset.id));
  });
  $('#add-lead').addEventListener('click', () => openLead({ status: 'new' }));

  function openLead(lead) {
    const dlg = $('#lead-dialog');
    const site = lead.id && siteByLead[lead.id];
    dlg.innerHTML = `
      <form method="dialog" class="stack" id="lead-form">
        <div class="row spread"><h2 style="margin:0">${lead.id ? esc(lead.name) : 'New lead'}</h2><button class="btn ghost" value="cancel" formnovalidate>✕</button></div>
        <div class="form-grid">
          <label>Name<input name="name" value="${esc(lead.name)}" required></label>
          <label>Category<input name="category" value="${esc(lead.category)}"></label>
          <label>Phone<input name="phone" value="${esc(lead.phone)}"></label>
          <label>Email<input name="email" value="${esc(lead.email)}"></label>
          <label class="full">Address<input name="address" value="${esc(lead.address)}"></label>
          <label>Instagram<input name="instagram" value="${esc(lead.instagram)}"></label>
          <label>Status<select name="status">${STATUSES.map((s) => `<option ${s === lead.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <label>Follow up on<input type="date" name="followUpAt" value="${esc(lead.followUpAt)}"></label>
          <label class="full">Opening hours<input name="openingHours" value="${esc(lead.openingHours)}"></label>
          <label class="full">Notes<textarea name="notes" placeholder="Talked to the owner, Maria. Call back after 3pm…">${esc(lead.notes)}</textarea></label>
        </div>
        ${lead.website ? `<p class="small">Existing website: <a href="${esc(/^https?:/.test(lead.website) ? lead.website : `https://${lead.website}`)}" target="_blank" rel="noopener">${esc(lead.website)}</a></p>` : ''}
        <div class="row spread">
          <div class="row">${lead.id ? `<button class="btn danger" type="button" data-act="delete">Delete</button>` : ''}
            ${lead.phone ? `<a class="btn secondary" href="tel:${esc(lead.phone)}">Call</a>` : ''}
            ${lead.lat ? `<a class="btn secondary" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lead.name} ${lead.address || `${lead.lat},${lead.lon}`}`)}">Google Maps</a>` : ''}</div>
          <div class="row">${lead.id ? `<button class="btn secondary" type="button" data-act="build">${site ? 'Open site' : 'Build site'}</button>` : ''}<button class="btn" type="submit" value="save">Save</button></div>
        </div>
      </form>`;
    dlg.showModal();
    const f = $('#lead-form', dlg);
    const data = () => Object.fromEntries(new FormData(f).entries());
    f.addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      try {
        const saved = lead.id
          ? await api(`/leads/${lead.id}`, { method: 'PATCH', body: data() })
          : await api('/leads', { method: 'POST', body: { ...data(), source: 'manual' } });
        const i = list.findIndex((l) => l.id === saved.id);
        i >= 0 ? (list[i] = saved) : list.unshift(saved);
        dlg.close();
        draw();
      } catch (err) {
        toast(err.message, true);
      }
    });
    $('[data-act=delete]', dlg)?.addEventListener('click', async () => {
      if (!confirm(`Delete ${lead.name}?`)) return;
      await api(`/leads/${lead.id}`, { method: 'DELETE' });
      list.splice(list.indexOf(lead), 1);
      dlg.close();
      draw();
    });
    $('[data-act=build]', dlg)?.addEventListener('click', async () => {
      await api(`/leads/${lead.id}`, { method: 'PATCH', body: data() });
      const s = site || (await api(`/leads/${lead.id}/build`, { method: 'POST' }));
      dlg.close();
      location.hash = `#/site/${s.id}`;
    });
  }
}

// ---------- Sites ----------
async function sites() {
  const list = await api('/sites');
  view.innerHTML = `
    <div class="page-head"><div><h1>Sites</h1><p class="muted">Every site you've built, live or draft.</p></div>
      <button class="btn" id="new-site">+ New site</button></div>
    ${list.length ? `<div class="grid">${list.map((s) => `
      <div class="card stack" style="gap:8px">
        <div class="row spread"><b>${esc(s.business?.name)}</b><span class="pill ${s.published ? 'live' : ''}">${s.published ? 'Live' : 'Draft'}</span></div>
        <div class="muted small">${esc(s.business?.category || '')}${s.business?.address ? ` · ${esc(s.business.address)}` : ''}</div>
        <div class="small">${s.published ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url.replace(/^https?:\/\//, ''))}</a>` : '<span class="muted">Not published</span>'}</div>
        <div class="row spread"><span class="pill ${esc(s.billing?.status)}">${esc(s.billing?.status || 'unpaid')}</span><span class="small">${money(s.billing?.buildFee)} + ${money(s.billing?.monthly)}/mo</span></div>
        <a class="btn secondary" href="#/site/${s.id}">Edit</a>
      </div>`).join('')}</div>` : '<div class="card empty">No sites yet. Find a lead on the map and press <b>Build site</b>, or start a blank one.</div>'}`;
  $('#new-site').addEventListener('click', async () => {
    const s = await api('/sites', { method: 'POST', body: {} });
    location.hash = `#/site/${s.id}`;
  });
}

async function siteEditor(id) {
  let site = await api(`/sites/${id}`);
  let dirty = false;

  view.innerHTML = `
    <div class="editor">
      <div class="panel" id="panel"></div>
      <div class="preview-wrap" id="preview-wrap">
        <div class="row spread"><b>Live preview</b><div class="row">
          <button class="btn sm secondary" id="pv-desktop">🖥️</button><button class="btn sm secondary" id="pv-mobile">📱</button></div></div>
        <iframe id="preview" title="Site preview"></iframe>
      </div>
    </div>`;

  const panel = $('#panel');
  const field = (label, path, attrs = '') => `<label>${label}<input data-path="${path}" value="${esc(get(site, path))}" ${attrs}></label>`;
  const area = (label, path, attrs = '') => `<label>${label}<textarea data-path="${path}" ${attrs}>${esc(get(site, path))}</textarea></label>`;

  function draw() {
    const b = site.business || {};
    panel.innerHTML = `
      <div class="savebar row spread">
        <div><a href="#/sites" class="small">← Sites</a><h1 style="margin:0">${esc(b.name)}</h1></div>
        <div class="row">
          <button class="btn secondary" id="ai-btn" title="Write tagline, about, services and hours with AI">✨ AI copy</button>
          <button class="btn" id="save-btn">Save</button>
        </div>
      </div>

      <details class="section" open><summary>Publish</summary><div class="body">
        <label class="check"><input type="checkbox" data-path="published" ${site.published ? 'checked' : ''}> Site is live</label>
        <div class="form-grid">${field('URL slug', 'slug')}${field('Custom domain', 'domain', 'placeholder="joesbakery.com"')}</div>
        <div class="copybox"><input readonly value="${esc(site.url)}"><button class="btn sm secondary" data-copy="${esc(site.url)}">Copy</button><a class="btn sm secondary" href="${esc(site.url)}" target="_blank" rel="noopener">Open</a></div>
        ${site.domain ? `<p class="small muted">Point <b>${esc(site.domain)}</b> at this server: add an <code>A</code> record for <code>@</code> (and a <code>CNAME</code> for <code>www</code>) to your server's IP, and make sure your HTTPS proxy (e.g. Caddy) serves that domain too. See the README.</p>` : ''}
      </div></details>

      <details class="section" open><summary>Business</summary><div class="body"><div class="form-grid">
        ${field('Name', 'business.name')}${field('Category', 'business.category')}
        <div class="full">${field('Tagline', 'business.tagline')}</div>
        <div class="full">${area('About', 'business.about')}</div>
        ${field('Phone', 'business.phone')}${field('Email', 'business.email')}
        <div class="full">${field('Address', 'business.address')}</div>
        ${field('Instagram', 'business.instagram', 'placeholder="@handle"')}${field('Facebook', 'business.facebook')}
        ${field('Latitude', 'business.lat')}${field('Longitude', 'business.lon')}
        <div class="full">${area('Opening hours (one line each)', 'hoursText', 'placeholder="Mon–Fri: 9am–6pm&#10;Sat: 10am–4pm&#10;Sun: Closed"')}</div>
      </div></div></details>

      <details class="section"><summary>Photos (${(site.photos || []).length})</summary><div class="body">
        <p class="small muted">The first photo is the big header image. Take photos on-site or ask the owner for some.</p>
        <div class="photos">${(site.photos || []).map((p, i) => `<div class="photo">${i === 0 ? '<span class="hero-tag">Header</span>' : ''}<img src="${esc(p)}" alt=""><div class="tools">
          <button data-photo="left" data-i="${i}" title="Move earlier">◀</button><button data-photo="del" data-i="${i}" title="Remove">✕</button><button data-photo="right" data-i="${i}" title="Move later">▶</button></div></div>`).join('')}</div>
        <div class="row"><label class="btn secondary">Upload photos<input type="file" accept="image/*" multiple id="photo-upload" hidden></label>
          <input id="photo-url" placeholder="…or paste an image URL" style="flex:1;min-width:160px"><button class="btn secondary" id="photo-url-add">Add</button></div>
      </div></details>

      <details class="section"><summary>Services (${(site.services || []).length})</summary><div class="body">
        ${(site.services || []).map((s, i) => `<div class="repeat-item"><div class="form-grid">${field('Name', `services.${i}.name`)}${field('Price', `services.${i}.price`, 'placeholder="$25"')}</div>
          ${field('Description', `services.${i}.description`)}<div><button class="btn sm danger" data-remove="services" data-i="${i}">Remove</button></div></div>`).join('')}
        <div><button class="btn sm secondary" data-add="services">+ Add service</button></div>
      </div></details>

      <details class="section"><summary>Reviews (${(site.reviews || []).length})</summary><div class="body">
        <p class="small muted">Copy a few real reviews (Google, Yelp) with the owner's permission.</p>
        ${(site.reviews || []).map((r, i) => `<div class="repeat-item">${area('Review', `reviews.${i}.text`)}<div class="form-grid">${field('Author', `reviews.${i}.author`)}${field('Stars (1–5)', `reviews.${i}.rating`, 'type="number" min="1" max="5"')}</div>
          <div><button class="btn sm danger" data-remove="reviews" data-i="${i}">Remove</button></div></div>`).join('')}
        <div><button class="btn sm secondary" data-add="reviews">+ Add review</button></div>
      </div></details>

      <details class="section"><summary>Look &amp; features</summary><div class="body">
        <div class="form-grid">
          <label>Template<select data-path="template">${(site.templates || ['classic']).map((t) => `<option ${t === site.template ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Accent color<input type="color" data-path="color" value="${esc(site.color || '#c2410c')}"></label>
        </div>
        <label class="check"><input type="checkbox" data-path="features.contactForm" ${site.features?.contactForm !== false ? 'checked' : ''}> Contact form</label>
        <label class="check"><input type="checkbox" data-path="features.booking" ${site.features?.booking !== false ? 'checked' : ''}> Booking requests</label>
        <label class="check"><input type="checkbox" data-path="features.map" ${site.features?.map !== false ? 'checked' : ''}> Map</label>
      </div></details>

      <details class="section" open><summary>Client &amp; billing</summary><div class="body">
        <div class="form-grid">
          ${field('Build fee ($)', 'billing.buildFee', 'type="number" min="0" step="1"')}
          ${field('Monthly ($)', 'billing.monthly', 'type="number" min="0" step="1"')}
          <label>Status<select data-path="billing.status">${['unpaid', 'pending', 'active', 'past_due', 'canceled'].map((s) => `<option ${s === (site.billing?.status || 'unpaid') ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          ${field("Owner's email", 'ownerEmail', 'type="email"')}
        </div>
        <label>Owner portal link <span class="muted small">(send this to the owner: they can pay, see messages and request changes)</span></label>
        <div class="copybox"><input readonly value="${esc(site.portalUrl)}"><button class="btn sm secondary" data-copy="${esc(site.portalUrl)}">Copy</button><a class="btn sm secondary" href="${esc(site.portalUrl)}" target="_blank" rel="noopener">Open</a></div>
        <div class="row">
          <button class="btn secondary sm" id="pay-link">💳 Create payment link</button>
          <button class="btn secondary sm" id="pitch">📋 Copy pitch message</button>
          ${site.billing?.stripeSubscriptionId ? '<button class="btn secondary sm" id="sync">↻ Sync from Stripe</button><button class="btn danger sm" id="cancel-sub">Cancel subscription</button>' : ''}
          <button class="btn ghost sm" id="rotate">Reset portal link</button>
        </div>
        ${area('Private notes', 'notes')}
      </div></details>

      <div class="row"><button class="btn danger" id="delete-site">Delete site</button></div>`;
  }

  function get(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) ?? '';
  }
  function set(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    keys.slice(0, -1).forEach((k, i) => {
      if (o[k] == null) o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
      o = o[k];
    });
    o[keys.at(-1)] = value;
  }
  const body = () => ({
    slug: site.slug, published: site.published, domain: site.domain, template: site.template, color: site.color,
    business: site.business, hoursText: site.hoursText, services: site.services, reviews: site.reviews, photos: site.photos,
    features: site.features, billing: site.billing, ownerEmail: site.ownerEmail, notes: site.notes,
  });

  let previewTimer;
  async function refreshPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const iframe = $('#preview');
      if (!iframe) return;
      const html = await api(`/sites/${site.id}/preview`, { method: 'POST', body: body() });
      // Keep the scroll position across refreshes.
      const y = iframe.contentWindow?.scrollY || 0;
      iframe.srcdoc = html;
      iframe.onload = () => iframe.contentWindow.scrollTo(0, y);
    }, 250);
  }

  async function save() {
    try {
      const saved = await api(`/sites/${site.id}`, { method: 'PATCH', body: body() });
      site = { ...site, ...saved };
      dirty = false;
      toast('Saved');
      draw();
    } catch (err) {
      toast(err.message, true);
    }
  }

  panel.addEventListener('input', (e) => {
    const path = e.target.dataset.path;
    if (!path) return;
    let value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.target.type === 'number') value = value === '' ? '' : Number(value);
    set(site, path, value);
    dirty = true;
    refreshPreview();
  });

  panel.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-copy]');
    if (!t) return;
    if (t.dataset.copy) return copy(t.dataset.copy);
    if (t.dataset.add) {
      site[t.dataset.add] = [...(site[t.dataset.add] || []), t.dataset.add === 'reviews' ? { text: '', author: '', rating: 5 } : { name: '', description: '', price: '' }];
      dirty = true;
      const open = openSections();
      draw();
      restoreSections(open);
      return refreshPreview();
    }
    if (t.dataset.remove) {
      site[t.dataset.remove].splice(Number(t.dataset.i), 1);
      dirty = true;
      const open = openSections();
      draw();
      restoreSections(open);
      return refreshPreview();
    }
    if (t.dataset.photo) {
      const i = Number(t.dataset.i);
      const p = site.photos;
      if (t.dataset.photo === 'del') p.splice(i, 1);
      if (t.dataset.photo === 'left' && i > 0) [p[i - 1], p[i]] = [p[i], p[i - 1]];
      if (t.dataset.photo === 'right' && i < p.length - 1) [p[i + 1], p[i]] = [p[i], p[i + 1]];
      dirty = true;
      const open = openSections();
      draw();
      restoreSections(open);
      return refreshPreview();
    }
    switch (t.id) {
      case 'save-btn': return save();
      case 'ai-btn': return aiCopy(t);
      case 'photo-url-add': {
        const url = $('#photo-url').value.trim();
        if (!/^https?:\/\//.test(url)) return toast('Paste a full https:// image URL', true);
        site.photos = [...(site.photos || []), url];
        dirty = true;
        const open = openSections();
        draw();
        restoreSections(open);
        return refreshPreview();
      }
      case 'pay-link': {
        if (dirty) await save();
        try {
          const { url } = await api(`/sites/${site.id}/checkout`, { method: 'POST' });
          copy(url);
          toast('Stripe payment link copied');
        } catch (err) { toast(err.message, true); }
        return;
      }
      case 'pitch': {
        const b = site.business || {};
        return copy(`Hi${b.name ? ` ${b.name}` : ''}! I noticed you don't have a website yet, so I built you one. Take a look: ${site.url}\n\nIt includes your hours, services, photos, a contact form and booking requests. It's yours for ${money(site.billing?.buildFee)} up front and ${money(site.billing?.monthly)}/month for hosting, updates and support. Happy to make any changes you'd like!`);
      }
      case 'sync':
        try { site = { ...site, ...(await api(`/sites/${site.id}/sync-billing`, { method: 'POST' })) }; draw(); toast('Billing synced'); } catch (err) { toast(err.message, true); }
        return;
      case 'cancel-sub':
        if (!confirm('Cancel this Stripe subscription now?')) return;
        try { site = { ...site, ...(await api(`/sites/${site.id}/cancel-subscription`, { method: 'POST' })) }; draw(); toast('Subscription canceled'); } catch (err) { toast(err.message, true); }
        return;
      case 'rotate':
        if (!confirm('Create a new portal link? The old one stops working.')) return;
        site.portalUrl = (await api(`/sites/${site.id}/rotate-portal`, { method: 'POST' })).portalUrl;
        draw();
        return;
      case 'delete-site':
        if (!confirm('Delete this site permanently?')) return;
        await api(`/sites/${site.id}`, { method: 'DELETE' });
        dirty = false;
        location.hash = '#/sites';
    }
  });

  panel.addEventListener('change', async (e) => {
    if (e.target.id !== 'photo-upload') return;
    for (const file of e.target.files) {
      try {
        const dataUrl = await resizeImage(file, 1800);
        const { url } = await api('/upload', { method: 'POST', body: { dataUrl } });
        site.photos = [...(site.photos || []), url];
      } catch (err) {
        toast(err.message, true);
      }
    }
    dirty = true;
    const open = openSections();
    draw();
    restoreSections(open);
    refreshPreview();
  });

  async function aiCopy(btn) {
    btn.disabled = true;
    btn.textContent = '✨ Writing…';
    try {
      const copy = await api(`/sites/${site.id}/ai`, { method: 'POST', body: body() });
      site.business = { ...site.business, tagline: copy.tagline, about: copy.about };
      if (copy.services?.length) site.services = copy.services;
      if (copy.hoursText) site.hoursText = copy.hoursText;
      dirty = true;
      const open = openSections();
      draw();
      restoreSections(open);
      refreshPreview();
      toast('Copy written. Review it, then Save.');
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = '✨ AI copy';
    }
  }

  const openSections = () => $$('details.section', panel).map((d) => d.open);
  const restoreSections = (states) => $$('details.section', panel).forEach((d, i) => (d.open = states[i] ?? d.open));

  $('#pv-desktop').addEventListener('click', () => $('#preview-wrap').classList.remove('mobile'));
  $('#pv-mobile').addEventListener('click', () => $('#preview-wrap').classList.add('mobile'));

  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  const keydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } };
  window.addEventListener('keydown', keydown);
  cleanup = () => {
    window.removeEventListener('beforeunload', beforeUnload);
    window.removeEventListener('keydown', keydown);
  };

  draw();
  refreshPreview();
}

function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error(`Could not read ${file.name}`));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Inbox ----------
async function inbox() {
  const data = await api('/inbox');
  view.innerHTML = `
    <div class="page-head"><div><h1>Inbox</h1><p class="muted">Messages and booking requests from your clients' sites, plus change requests from owners.</p></div></div>
    <div class="stack">
      <div class="card"><h2>Change requests</h2>${data.requests.length ? `<div class="table-wrap"><table>
        <tr><th>Site</th><th>Request</th><th>Status</th><th></th></tr>
        ${data.requests.map((r) => `<tr data-id="${r.id}"><td><b>${esc(r.siteName)}</b><div class="muted small">${fmtDate(r.createdAt)}</div></td>
          <td>${esc(r.text)}<input class="small" data-reply placeholder="Reply shown to owner…" value="${esc(r.reply)}" style="margin-top:6px"></td>
          <td><select data-req-status>${['open', 'in progress', 'done'].map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
          <td><button class="btn sm danger" data-del-req>✕</button></td></tr>`).join('')}
      </table></div>` : '<p class="muted">No change requests.</p>'}</div>
      <div class="card"><h2>Messages &amp; bookings</h2>${data.submissions.length ? `<div class="table-wrap"><table>
        <tr><th>Site</th><th>From</th><th>Details</th><th></th></tr>
        ${data.submissions.map((s) => `<tr data-id="${s.id}" style="${s.read ? 'opacity:.65' : ''}"><td><b>${esc(s.siteName)}</b><div class="muted small">${fmtDate(s.createdAt)}</div></td>
          <td>${esc(s.name)}<div class="small">${esc(s.contact)}</div></td>
          <td><span class="pill ${s.kind === 'booking' ? 'accent' : ''}">${s.kind}</span> ${esc([s.service, s.date, s.time].filter(Boolean).join(' · '))}<div>${esc(s.message)}</div></td>
          <td class="row"><button class="btn sm secondary" data-read>${s.read ? 'Unread' : 'Mark read'}</button><button class="btn sm danger" data-del-sub>✕</button></td></tr>`).join('')}
      </table></div>` : '<p class="muted">No messages yet.</p>'}</div>
    </div>`;

  view.addEventListener('change', async (e) => {
    const id = e.target.closest('tr')?.dataset.id;
    if (e.target.matches('[data-req-status]')) await api(`/requests/${id}`, { method: 'PATCH', body: { status: e.target.value } });
    if (e.target.matches('[data-reply]')) { await api(`/requests/${id}`, { method: 'PATCH', body: { reply: e.target.value } }); toast('Reply saved'); }
    refreshBadge();
  });
  view.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    if (e.target.matches('[data-read]')) {
      const s = data.submissions.find((x) => x.id === id);
      await api(`/submissions/${id}`, { method: 'PATCH', body: { read: !s.read } });
    } else if (e.target.matches('[data-del-sub]')) {
      if (!confirm('Delete this message?')) return;
      await api(`/submissions/${id}`, { method: 'DELETE' });
    } else if (e.target.matches('[data-del-req]')) {
      if (!confirm('Delete this request?')) return;
      await api(`/requests/${id}`, { method: 'DELETE' });
    } else return;
    refreshBadge();
    route();
  });
}

// ---------- Billing ----------
async function billing() {
  const [s, siteList, payments] = await Promise.all([api('/stats'), api('/sites'), api('/payments')]);
  const names = Object.fromEntries(siteList.map((x) => [x.id, x.business?.name]));
  view.innerHTML = `
    <div class="page-head"><div><h1>Billing</h1><p class="muted">Stripe payments land in your own Stripe account. Log cash or other payments by hand.</p></div></div>
    <div class="stats">${stat('Monthly recurring', money(s.mrr))}${stat('Yearly run-rate', money(s.mrr * 12))}${stat('Collected all-time', money(s.collected))}${stat('Paying clients', s.paying)}</div>
    <div class="card" style="margin-top:16px"><h2>Clients</h2><div class="table-wrap"><table>
      <tr><th>Site</th><th>Plan</th><th>Status</th><th>Paid</th></tr>
      ${siteList.map((x) => `<tr><td><a href="#/site/${x.id}">${esc(x.business?.name)}</a></td><td>${money(x.billing?.buildFee)} + ${money(x.billing?.monthly)}/mo</td>
        <td><span class="pill ${esc(x.billing?.status)}">${esc(x.billing?.status || 'unpaid')}</span></td>
        <td>${money(payments.filter((p) => p.siteId === x.id).reduce((a, p) => a + Number(p.amount), 0))}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No sites yet.</td></tr>'}
    </table></div></div>
    <div class="card" style="margin-top:16px"><h2>Record a payment</h2>
      <form id="pay-form" class="row">
        <select name="siteId" style="width:auto" required><option value="">Site…</option>${siteList.map((x) => `<option value="${x.id}">${esc(x.business?.name)}</option>`).join('')}</select>
        <input name="amount" type="number" min="0" step="0.01" placeholder="Amount" style="width:120px" required>
        <input name="note" placeholder="Note (e.g. cash, Venmo, October)" style="flex:1;min-width:160px">
        <label class="check"><input type="checkbox" name="markActive" checked> Mark plan active</label>
        <button class="btn">Add</button>
      </form></div>
    <div class="card" style="margin-top:16px"><h2>Payments</h2><div class="table-wrap"><table>
      <tr><th>Date</th><th>Site</th><th>Amount</th><th>Source</th><th>Note</th><th></th></tr>
      ${payments.map((p) => `<tr><td>${fmtDate(p.createdAt)}</td><td>${esc(names[p.siteId] || '—')}</td><td>${money(p.amount)}</td><td><span class="pill">${esc(p.source)}</span></td><td>${esc(p.note)}</td>
        <td><button class="btn sm danger" data-del="${p.id}">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No payments yet.</td></tr>'}
    </table></div></div>`;

  $('#pay-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/payments', { method: 'POST', body: { siteId: f.siteId.value, amount: f.amount.value, note: f.note.value, markActive: f.markActive.checked } });
      toast('Payment recorded');
      route();
    } catch (err) {
      toast(err.message, true);
    }
  });
  view.addEventListener('click', async (e) => {
    const id = e.target.dataset?.del;
    if (!id || !confirm('Delete this payment record?')) return;
    await api(`/payments/${id}`, { method: 'DELETE' });
    route();
  });
}

// ---------- Settings ----------
async function settings() {
  const s = await api('/settings');
  const envNote = (k) => (s.envOverrides[k] ? '<span class="muted small">(set by environment variable)</span>' : '');
  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <form id="settings-form" class="stack" style="max-width:720px">
      <div class="card stack"><h2>General</h2><div class="form-grid">
        <label>Your name / business<input name="yourName" value="${esc(s.yourName)}"></label>
        <label>Public base URL ${envNote('baseUrl')}<input name="baseUrl" value="${esc(s.baseUrl)}" placeholder="https://sites.example.com"></label>
        <label>Currency<input name="currency" value="${esc(s.currency)}" placeholder="usd"></label>
        <label>Default build fee ($)<input name="defaultBuildFee" type="number" min="0" value="${esc(s.defaultBuildFee)}"></label>
        <label>Default monthly ($)<input name="defaultMonthly" type="number" min="0" value="${esc(s.defaultMonthly)}"></label>
      </div><p class="small muted">The base URL is used for hosted site links, owner portals and Stripe redirects.</p></div>

      <div class="card stack"><h2>Stripe (payments)</h2>
        <label>Secret key ${envNote('stripeSecretKey')}<input name="stripeSecretKey" value="${esc(s.stripeSecretKey)}" placeholder="sk_live_… or sk_test_…" autocomplete="off"></label>
        <label>Webhook signing secret (optional) ${envNote('stripeWebhookSecret')}<input name="stripeWebhookSecret" value="${esc(s.stripeWebhookSecret)}" placeholder="whsec_…" autocomplete="off"></label>
        <p class="small muted">To track monthly renewals and cancellations automatically, add a webhook in Stripe pointing to <code>${esc(s.webhookUrl)}</code> with events <code>checkout.session.completed</code>, <code>invoice.paid</code>, <code>customer.subscription.updated</code>, <code>customer.subscription.deleted</code>. Turn on the Customer Portal in Stripe so owners can update cards.</p>
      </div>

      <div class="card stack"><h2>AI copywriting (optional)</h2>
        <label>Anthropic API key ${envNote('anthropicApiKey')}<input name="anthropicApiKey" value="${esc(s.anthropicApiKey)}" placeholder="sk-ant-…" autocomplete="off"></label>
        <p class="small muted">Used by the ✨ AI copy button to write taglines, about text, services and hours. Get a key at console.anthropic.com.</p>
      </div>

      <div class="row"><button class="btn">Save settings</button></div>
    </form>
    <div class="card stack" style="max-width:720px;margin-top:16px"><h2>Data</h2>
      <div class="row"><a class="btn secondary" href="/api/export">⬇️ Download backup (JSON)</a><button class="btn secondary" id="logout">Log out</button></div>
    </div>`;

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/settings', { method: 'PUT', body: Object.fromEntries(new FormData(e.target).entries()) });
      toast('Settings saved');
      route();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' });
    showLogin();
  });
}

start();
