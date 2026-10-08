// Renders a business's one-page website from its stored site record.
// Three looks share one structure: "classic", "bold" and "minimal".

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const TEMPLATES = {
  classic: {
    font: "'Georgia', 'Times New Roman', serif",
    bodyFont: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    bg: '#fbf8f3',
    text: '#2b2621',
    muted: '#6f655b',
    card: '#ffffff',
    radius: '10px',
    heroOverlay: 'linear-gradient(180deg, rgba(0,0,0,.25), rgba(0,0,0,.6))',
  },
  bold: {
    font: "'Arial Black', 'Helvetica Neue', Arial, sans-serif",
    bodyFont: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    bg: '#111111',
    text: '#f5f5f5',
    muted: '#b5b5b5',
    card: '#1d1d1d',
    radius: '2px',
    heroOverlay: 'linear-gradient(180deg, rgba(0,0,0,.35), rgba(0,0,0,.85))',
  },
  minimal: {
    font: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    bodyFont: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    bg: '#ffffff',
    text: '#1a1a1a',
    muted: '#666666',
    card: '#f6f6f6',
    radius: '16px',
    heroOverlay: 'linear-gradient(180deg, rgba(0,0,0,.15), rgba(0,0,0,.5))',
  },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

function stars(n) {
  const r = Math.max(0, Math.min(5, Math.round(Number(n) || 5)));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

function safeUrl(url) {
  const s = String(url ?? '').trim();
  if (/^(https?:\/\/|\/)/i.test(s)) return s;
  return '';
}

function normalizeHandle(value, base) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return base + s.replace(/^@/, '');
}

export function renderSite(site, { formAction = '', preview = false } = {}) {
  const t = TEMPLATES[site.template] || TEMPLATES.classic;
  const b = site.business || {};
  const accent = /^#[0-9a-f]{3,8}$/i.test(site.color || '') ? site.color : '#c2410c';
  const photos = (site.photos || []).map(safeUrl).filter(Boolean);
  const hero = photos[0];
  const gallery = photos.slice(1);
  const services = (site.services || []).filter((s) => s.name);
  const reviews = (site.reviews || []).filter((r) => r.text);
  const hours = String(site.hoursText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const features = { contactForm: true, booking: true, map: true, ...(site.features || {}) };
  const instagram = normalizeHandle(b.instagram, 'https://instagram.com/');
  const facebook = normalizeHandle(b.facebook, 'https://facebook.com/');
  const mapQuery = encodeURIComponent([b.name, b.address].filter(Boolean).join(', '));
  const hasCoords = Number.isFinite(Number(b.lat)) && Number.isFinite(Number(b.lon)) && b.lat !== '' && b.lon !== '';

  const nav = [
    services.length && '<a href="#services">Services</a>',
    reviews.length && '<a href="#reviews">Reviews</a>',
    (hours.length || b.address) && '<a href="#visit">Visit</a>',
    (features.contactForm || features.booking) && '<a href="#contact">Contact</a>',
  ].filter(Boolean).join('');

  const description = b.tagline || b.about || `${b.name || 'Local business'}${b.category ? ` – ${b.category}` : ''}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(b.name || 'Untitled business')}${b.category ? ` · ${esc(b.category)}` : ''}</title>
<meta name="description" content="${esc(String(description).slice(0, 160))}">
<meta property="og:title" content="${esc(b.name)}">
<meta property="og:description" content="${esc(String(description).slice(0, 200))}">
${hero ? `<meta property="og:image" content="${esc(hero)}">` : ''}
${preview ? '<meta name="robots" content="noindex">' : ''}
<style>
:root{--accent:${accent};--bg:${t.bg};--text:${t.text};--muted:${t.muted};--card:${t.card};--radius:${t.radius}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:${t.bodyFont};line-height:1.6}
h1,h2,h3{font-family:${t.font};line-height:1.15;margin:0 0 .5em}
a{color:var(--accent)}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid color-mix(in srgb,var(--text) 10%,transparent)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:60px}
.brand{font-family:${t.font};font-weight:700;font-size:1.15rem;color:var(--text);text-decoration:none}
nav{display:flex;gap:18px;flex-wrap:wrap}
nav a{color:var(--text);text-decoration:none;font-size:.95rem;opacity:.85}
nav a:hover{opacity:1;color:var(--accent)}
.hero{position:relative;min-height:62vh;display:flex;align-items:flex-end;color:#fff;background:${hero ? `${t.heroOverlay}, url("${esc(hero)}") center/cover` : `linear-gradient(135deg,var(--accent),color-mix(in srgb,var(--accent) 45%,#000))`}}
.hero .wrap{padding-top:80px;padding-bottom:56px;width:100%}
.hero h1{font-size:clamp(2.2rem,6vw,4rem)}
.hero p{font-size:clamp(1.05rem,2.2vw,1.3rem);max-width:620px;opacity:.95;margin:0 0 24px}
.btn{display:inline-block;background:var(--accent);color:#fff;border:0;padding:13px 22px;border-radius:var(--radius);font-weight:600;text-decoration:none;cursor:pointer;font-size:1rem}
.btn.ghost{background:transparent;border:2px solid #fff;margin-left:8px}
section{padding:72px 0}
section h2{font-size:clamp(1.6rem,3.5vw,2.3rem)}
.lead{color:var(--muted);max-width:680px;font-size:1.08rem}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.card{background:var(--card);border-radius:var(--radius);padding:22px;border:1px solid color-mix(in srgb,var(--text) 8%,transparent)}
.card h3{font-size:1.15rem;display:flex;justify-content:space-between;gap:8px}
.price{color:var(--accent);font-family:${t.bodyFont};white-space:nowrap}
.card p{margin:0;color:var(--muted)}
.gallery{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--radius);display:block}
.stars{color:#f5a524;letter-spacing:2px}
blockquote{margin:0}
.who{margin-top:10px;font-weight:600}
.visit{display:grid;gap:28px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.hours{list-style:none;padding:0;margin:0}
.hours li{padding:6px 0;border-bottom:1px dashed color-mix(in srgb,var(--text) 15%,transparent)}
iframe.map{width:100%;height:320px;border:0;border-radius:var(--radius)}
form{display:grid;gap:12px}
label{font-size:.9rem;font-weight:600}
input,textarea,select{width:100%;padding:11px 12px;border-radius:var(--radius);border:1px solid color-mix(in srgb,var(--text) 22%,transparent);background:var(--bg);color:var(--text);font:inherit}
textarea{min-height:110px}
.row2{display:grid;gap:12px;grid-template-columns:1fr 1fr}
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tabs button{background:transparent;color:var(--text);border:1px solid color-mix(in srgb,var(--text) 25%,transparent);padding:8px 14px;border-radius:999px;cursor:pointer;font:inherit}
.tabs button[aria-selected=true]{background:var(--accent);border-color:var(--accent);color:#fff}
.notice{padding:12px 14px;border-radius:var(--radius);background:color-mix(in srgb,var(--accent) 15%,var(--bg));display:none}
footer{padding:36px 0;color:var(--muted);font-size:.9rem;border-top:1px solid color-mix(in srgb,var(--text) 10%,transparent)}
footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
.hp{position:absolute;left:-9999px}
@media (max-width:640px){nav{display:none}.row2{grid-template-columns:1fr}.btn.ghost{margin:10px 0 0}}
</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="#">${esc(b.name || 'Business name')}</a><nav>${nav}</nav></div></header>

<div class="hero"><div class="wrap">
  <h1>${esc(b.name || 'Business name')}</h1>
  ${b.tagline ? `<p>${esc(b.tagline)}</p>` : ''}
  ${b.phone ? `<a class="btn" href="tel:${esc(String(b.phone).replace(/[^0-9+]/g, ''))}">Call ${esc(b.phone)}</a>` : ''}
  ${features.booking ? `<a class="btn ${b.phone ? 'ghost' : ''}" href="#contact" data-tab="book">Book now</a>` : ''}
</div></div>

${b.about ? `<section id="about"><div class="wrap"><h2>About us</h2><p class="lead">${esc(b.about).replace(/\n/g, '<br>')}</p></div></section>` : ''}

${services.length ? `<section id="services"><div class="wrap"><h2>Services</h2><div class="grid">
${services.map((s) => `<div class="card"><h3><span>${esc(s.name)}</span>${s.price ? `<span class="price">${esc(s.price)}</span>` : ''}</h3>${s.description ? `<p>${esc(s.description)}</p>` : ''}</div>`).join('\n')}
</div></div></section>` : ''}

${gallery.length ? `<section id="gallery"><div class="wrap"><h2>Gallery</h2><div class="gallery">
${gallery.map((p) => `<img src="${esc(p)}" alt="${esc(b.name)} photo" loading="lazy">`).join('\n')}
</div></div></section>` : ''}

${reviews.length ? `<section id="reviews"><div class="wrap"><h2>What customers say</h2><div class="grid">
${reviews.map((r) => `<div class="card"><div class="stars" aria-label="${esc(r.rating || 5)} out of 5">${stars(r.rating)}</div><blockquote><p>“${esc(r.text)}”</p></blockquote>${r.author ? `<div class="who">— ${esc(r.author)}</div>` : ''}</div>`).join('\n')}
</div></div></section>` : ''}

${hours.length || b.address ? `<section id="visit"><div class="wrap"><h2>Visit us</h2><div class="visit">
<div>
  ${b.address ? `<p><strong>${esc(b.address)}</strong><br><a href="https://www.google.com/maps/search/?api=1&query=${mapQuery}" target="_blank" rel="noopener">Get directions</a></p>` : ''}
  ${hours.length ? `<ul class="hours">${hours.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
  <p>${b.phone ? `📞 <a href="tel:${esc(String(b.phone).replace(/[^0-9+]/g, ''))}">${esc(b.phone)}</a><br>` : ''}${b.email ? `✉️ <a href="mailto:${esc(b.email)}">${esc(b.email)}</a><br>` : ''}${instagram ? `📷 <a href="${esc(instagram)}" target="_blank" rel="noopener">Instagram</a> ` : ''}${facebook ? `👍 <a href="${esc(facebook)}" target="_blank" rel="noopener">Facebook</a>` : ''}</p>
</div>
${features.map && (hasCoords || b.address) ? `<iframe class="map" loading="lazy" title="Map" src="${hasCoords
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${Number(b.lon) - 0.006}%2C${Number(b.lat) - 0.004}%2C${Number(b.lon) + 0.006}%2C${Number(b.lat) + 0.004}&layer=mapnik&marker=${Number(b.lat)}%2C${Number(b.lon)}`
    : `https://maps.google.com/maps?q=${mapQuery}&output=embed`}"></iframe>` : ''}
</div></div></section>` : ''}

${features.contactForm || features.booking ? `<section id="contact"><div class="wrap"><h2>Get in touch</h2>
${features.contactForm && features.booking ? `<div class="tabs" role="tablist"><button type="button" role="tab" aria-selected="true" data-kind="contact">Message</button><button type="button" role="tab" aria-selected="false" data-kind="booking">Book an appointment</button></div>` : ''}
<form id="pd-form" method="post" action="${esc(formAction)}">
  <input type="hidden" name="kind" value="${features.contactForm ? 'contact' : 'booking'}">
  <input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
  <div class="row2"><div><label for="f-name">Name</label><input id="f-name" name="name" required></div>
  <div><label for="f-contact">Phone or email</label><input id="f-contact" name="contact" required></div></div>
  <div class="booking-only row2" ${features.contactForm ? 'hidden' : ''}>
    <div><label for="f-date">Preferred date</label><input id="f-date" type="date" name="date"></div>
    <div><label for="f-time">Preferred time</label><input id="f-time" type="time" name="time"></div>
    ${services.length ? `<div style="grid-column:1/-1"><label for="f-svc">Service</label><select id="f-svc" name="service"><option value="">Any</option>${services.map((s) => `<option>${esc(s.name)}</option>`).join('')}</select></div>` : ''}
  </div>
  <div><label for="f-msg">Message</label><textarea id="f-msg" name="message"></textarea></div>
  <div><button class="btn" type="submit">Send</button></div>
  <div class="notice" role="status"></div>
</form>
</div></section>` : ''}

<footer><div class="wrap"><span>© ${new Date().getFullYear()} ${esc(b.name)}</span>${b.address ? `<span>${esc(b.address)}</span>` : ''}</div></footer>

<script>
(function(){
  var form=document.getElementById('pd-form'); if(!form) return;
  var kind=form.querySelector('[name=kind]'), extra=form.querySelector('.booking-only');
  function setKind(k){kind.value=k; if(extra) extra.hidden=(k!=='booking');
    document.querySelectorAll('.tabs button').forEach(function(b){b.setAttribute('aria-selected', String(b.dataset.kind===k));});}
  document.querySelectorAll('.tabs button').forEach(function(b){b.addEventListener('click',function(){setKind(b.dataset.kind);});});
  document.querySelectorAll('[data-tab=book]').forEach(function(a){a.addEventListener('click',function(){if(document.querySelector('.tabs')) setKind('booking');});});
  form.addEventListener('submit',function(e){
    e.preventDefault(); var note=form.querySelector('.notice');
    ${preview ? "note.style.display='block'; note.textContent='Preview mode: form submissions are disabled.'; return;" : ''}
    var data=Object.fromEntries(new FormData(form).entries());
    fetch(form.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
      .then(function(r){return r.ok?r.json():Promise.reject();})
      .then(function(){form.reset(); setKind(kind.defaultValue); note.style.display='block'; note.textContent='Thanks! We\\'ll be in touch soon.';})
      .catch(function(){note.style.display='block'; note.textContent='Sorry, something went wrong. Please call us instead.';});
  });
})();
</script>
</body>
</html>`;
}
