// Server-rendered pages for business owners: their portal and simple notices.
import { esc } from './render.js';

const STYLE = `
:root{--bg:#f7f7f8;--card:#fff;--text:#18181b;--muted:#71717a;--line:#e4e4e7;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f11;--card:#18181b;--text:#f4f4f5;--muted:#a1a1aa;--line:#27272a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.1rem;margin:0 0 12px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:16px}
.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn.secondary{background:transparent;color:var(--text);border:1px solid var(--line)}
textarea{width:100%;min-height:110px;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.8rem;font-weight:600;background:var(--line)}
.pill.active{background:#dcfce7;color:#166534}.pill.past_due,.pill.canceled{background:#fee2e2;color:#991b1b}
ul.list{list-style:none;margin:0;padding:0}ul.list li{padding:10px 0;border-bottom:1px solid var(--line)}ul.list li:last-child{border:0}
.flash{background:#dcfce7;color:#166534;padding:10px 14px;border-radius:8px;margin-top:16px}
a{color:var(--accent)}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

export function renderMessage(title, message) {
  return page(title, `<h1>${esc(title)}</h1><p class="muted">${esc(message)}</p>`);
}

const money = (n) => `$${Number(n || 0).toFixed(2).replace(/\.00$/, '')}`;
const fmtDate = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const STATUS_LABEL = { unpaid: 'Not paid yet', pending: 'Awaiting payment', active: 'Active', past_due: 'Payment overdue', canceled: 'Canceled' };

export function renderPortal({ site, siteUrl, submissions, requests, stripeEnabled, flash }) {
  const b = site.business || {};
  const billing = site.billing || {};
  const status = billing.status || 'unpaid';
  const canPay = stripeEnabled && status !== 'active' && (Number(billing.buildFee) > 0 || Number(billing.monthly) > 0);

  return page(
    `${b.name || 'Your website'} – owner portal`,
    `
<h1>${esc(b.name || 'Your website')}</h1>
<p class="muted">Your website dashboard. Keep this link private; anyone with it can view this page.</p>
${flash ? `<div class="flash">${esc(flash)}</div>` : ''}

<div class="card">
  <h2>Your website</h2>
  ${site.published
    ? `<p><a href="${esc(siteUrl)}" target="_blank" rel="noopener">${esc(siteUrl)}</a></p>`
    : '<p class="muted">Your site is being prepared and is not live yet.</p>'}
</div>

<div class="card">
  <h2>Plan &amp; billing <span class="pill ${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span></h2>
  <p>${Number(billing.buildFee) > 0 ? `${money(billing.buildFee)} one-time setup` : ''}${Number(billing.buildFee) > 0 && Number(billing.monthly) > 0 ? ' + ' : ''}${Number(billing.monthly) > 0 ? `${money(billing.monthly)}/month for hosting, updates and support` : ''}</p>
  ${canPay ? `<form method="post" action="/portal/${esc(site.ownerToken)}/pay"><button class="btn">Pay securely with card</button></form>` : ''}
  ${billing.stripeCustomerId && stripeEnabled ? `<form method="post" action="/portal/${esc(site.ownerToken)}/manage-billing" style="margin-top:10px"><button class="btn secondary">Update card or cancel</button></form>` : ''}
</div>

<div class="card">
  <h2>Request a change</h2>
  <p class="muted">New photos, updated hours, a price change: describe it and it'll be taken care of.</p>
  <form method="post" action="/portal/${esc(site.ownerToken)}/request">
    <textarea name="text" required placeholder="e.g. We're closed on Mondays starting next month."></textarea>
    <p><button class="btn">Send request</button></p>
  </form>
  ${requests.length ? `<ul class="list">${requests.map((r) => `<li><span class="pill">${esc(r.status)}</span> ${esc(r.text)}<div class="muted" style="font-size:.85rem">${fmtDate(r.createdAt)}${r.reply ? ` · Reply: ${esc(r.reply)}` : ''}</div></li>`).join('')}</ul>` : ''}
</div>

<div class="card">
  <h2>Messages &amp; bookings from your website</h2>
  ${submissions.length
    ? `<ul class="list">${submissions.map((s) => `<li><strong>${esc(s.name)}</strong> · ${esc(s.contact)} <span class="pill">${s.kind === 'booking' ? 'Booking' : 'Message'}</span>
        ${s.kind === 'booking' ? `<div>${esc([s.service, s.date, s.time].filter(Boolean).join(' · '))}</div>` : ''}
        ${s.message ? `<div>${esc(s.message)}</div>` : ''}<div class="muted" style="font-size:.85rem">${fmtDate(s.createdAt)}</div></li>`).join('')}</ul>`
    : '<p class="muted">Nothing yet. Messages and booking requests from your site will show up here.</p>'}
</div>`,
  );
}
