import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp, slugify, normalizeDomain } from '../src/server.js';
import { renderSite } from '../src/render.js';
import { verifyWebhook } from '../src/stripe.js';

let server;
let base;
let cookie = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pindrop-test-'));

async function req(p, { method = 'GET', body, headers = {}, redirect = 'manual' } = {}) {
  const res = await fetch(base + p, {
    method,
    redirect,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { res, data: type.includes('json') ? await res.json() : await res.text() };
}

before(async () => {
  const { app } = createApp({ dataDir, password: 'hunter2', log: () => {} });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('helpers', () => {
  assert.equal(slugify("Joe's Café & Bakery!"), 'joe-s-cafe-bakery');
  assert.equal(normalizeDomain('https://www.Example.com/path'), 'example.com');
});

test('admin API requires login', async () => {
  const { res } = await req('/api/leads');
  assert.equal(res.status, 401);
  const bad = await req('/api/login', { method: 'POST', body: { password: 'nope' } });
  assert.equal(bad.res.status, 401);
  const ok = await req('/api/login', { method: 'POST', body: { password: 'hunter2' } });
  assert.equal(ok.res.status, 200);
  cookie = ok.res.headers.get('set-cookie').split(';')[0];
  const me = await req('/api/me');
  assert.equal(me.data.authed, true);
});

test('lead → site → publish → form submission → portal flow', async () => {
  const lead = (await req('/api/leads', {
    method: 'POST',
    body: { osmId: 'node/1', name: "Rosa's Tacos", category: 'Restaurant', phone: '555-0100', openingHours: 'Mo-Fr 11:00-21:00; Sa 12:00-22:00', lat: 40.7, lon: -74 },
  })).data;
  assert.equal(lead.status, 'new');

  const dupe = (await req('/api/leads', { method: 'POST', body: { osmId: 'node/1', name: "Rosa's Tacos" } })).data;
  assert.equal(dupe.duplicate, true);
  assert.equal(dupe.id, lead.id);

  const site = (await req(`/api/leads/${lead.id}/build`, { method: 'POST' })).data;
  assert.equal(site.slug, 'rosa-s-tacos');
  assert.equal(site.business.name, "Rosa's Tacos");
  assert.equal(site.hoursText, 'Mo-Fr 11:00-21:00\nSa 12:00-22:00');

  // Unpublished: hidden from the public, visible to the logged-in admin as a preview.
  const savedCookie = cookie;
  cookie = '';
  assert.equal((await req('/s/rosa-s-tacos')).res.status, 404);
  cookie = savedCookie;
  assert.equal((await req('/s/rosa-s-tacos')).res.status, 200);

  const patched = (await req(`/api/sites/${site.id}`, {
    method: 'PATCH',
    body: { published: true, services: [{ name: 'Tacos al pastor', price: '$3', description: '' }], business: { ...site.business, tagline: '<script>alert(1)</script>' } },
  })).data;
  assert.equal(patched.published, true);
  assert.equal((await req('/api/leads')).data[0].status, 'pitched');

  cookie = '';
  const page = await req('/s/rosa-s-tacos');
  assert.equal(page.res.status, 200);
  assert.match(page.data, /Rosa&#39;s Tacos/);
  assert.match(page.data, /Tacos al pastor/);
  assert.ok(!page.data.includes('<script>alert(1)</script>'), 'user content is escaped');

  const sub = await req('/s/rosa-s-tacos/form', { method: 'POST', body: { kind: 'booking', name: 'Ana', contact: 'ana@example.com', date: '2026-10-10', service: 'Tacos al pastor' } });
  assert.equal(sub.res.status, 200);
  const missing = await req('/s/rosa-s-tacos/form', { method: 'POST', body: { name: '' } });
  assert.equal(missing.res.status, 400);

  // Owner portal shows the booking and accepts change requests.
  const portal = await req(`/portal/${site.ownerToken}`);
  assert.equal(portal.res.status, 200);
  assert.match(portal.data, /Ana/);
  const change = await req(`/portal/${site.ownerToken}/request`, {
    method: 'POST',
    body: undefined,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(change.res.status, 303);
  const r2 = await fetch(`${base}/portal/${site.ownerToken}/request`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'text=Please+add+our+new+menu',
  });
  assert.equal(r2.status, 303);
  assert.equal((await req('/portal/not-a-real-token')).res.status, 404);

  cookie = savedCookie;
  const inbox = (await req('/api/inbox')).data;
  assert.equal(inbox.submissions.length, 1);
  assert.equal(inbox.submissions[0].kind, 'booking');
  assert.equal(inbox.requests.length, 1);
  assert.equal(inbox.requests[0].text, 'Please add our new menu');

  const stats = (await req('/api/stats')).data;
  assert.equal(stats.live, 1);
  assert.equal(stats.unreadSubmissions, 1);
  assert.equal(stats.openRequests, 1);
});

test('custom domains are served by Host header and must be unique', async () => {
  const sites = (await req('/api/sites')).data;
  const site = sites[0];
  const ok = await req(`/api/sites/${site.id}`, { method: 'PATCH', body: { domain: 'https://www.RosasTacos.com/' } });
  assert.equal(ok.data.domain, 'rosastacos.com');

  const other = (await req('/api/sites', { method: 'POST', body: { business: { name: 'Other' } } })).data;
  const clash = await req(`/api/sites/${other.id}`, { method: 'PATCH', body: { domain: 'rosastacos.com' } });
  assert.equal(clash.res.status, 400);

  // fetch() won't let us override Host, so use node:http directly.
  const html = await new Promise((resolve, reject) => {
    http.get(`${base}/`, { headers: { Host: 'rosastacos.com' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
  assert.match(html, /Rosa&#39;s Tacos/);
  assert.match(html, /action="\/__form"/);
});

test('manual payments update MRR and collected totals', async () => {
  const site = (await req('/api/sites')).data.find((s) => s.slug === 'rosa-s-tacos');
  await req(`/api/sites/${site.id}`, { method: 'PATCH', body: { billing: { buildFee: 300, monthly: 49 } } });
  const p = await req('/api/payments', { method: 'POST', body: { siteId: site.id, amount: 349, note: 'cash', markActive: true } });
  assert.equal(p.res.status, 200);
  const stats = (await req('/api/stats')).data;
  assert.equal(stats.mrr, 49);
  assert.equal(stats.collected, 349);
  assert.equal(stats.paying, 1);
});

test('settings never echo secrets back', async () => {
  await req('/api/settings', { method: 'PUT', body: { stripeSecretKey: 'sk_test_abcdef1234', yourName: 'Me' } });
  const s = (await req('/api/settings')).data;
  assert.equal(s.stripeSecretKey, '••••1234');
  // Saving the masked value back must not overwrite the real key.
  await req('/api/settings', { method: 'PUT', body: { stripeSecretKey: s.stripeSecretKey } });
  const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(db.settings.stripeSecretKey, 'sk_test_abcdef1234');
});

test('photo upload accepts images only', async () => {
  const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
  const ok = await req('/api/upload', { method: 'POST', body: { dataUrl: png } });
  assert.match(ok.data.url, /^\/uploads\/.+\.png$/);
  const file = await fetch(base + ok.data.url);
  assert.equal(file.status, 200);
  const bad = await req('/api/upload', { method: 'POST', body: { dataUrl: 'data:text/html;base64,PGgxPg==' } });
  assert.equal(bad.res.status, 400);
});

test('renderSite drops unsafe photo URLs', () => {
  const html = renderSite({ business: { name: 'X' }, photos: ['javascript:alert(1)', 'https://example.com/a.jpg'] });
  assert.ok(!html.includes('javascript:alert'));
  assert.match(html, /https:\/\/example\.com\/a\.jpg/);
});

test('stripe webhook signature verification', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1"}';
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  assert.equal(verifyWebhook(body, `t=${t},v1=${sig}`, secret), true);
  assert.equal(verifyWebhook(body, `t=${t},v1=${'0'.repeat(64)}`, secret), false);
  assert.equal(verifyWebhook(body, `t=${t - 3600},v1=${sig}`, secret), false);
});
