import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDb } from './db.js';
import { createAuth } from './auth.js';
import { renderSite, TEMPLATE_NAMES } from './render.js';
import { writeSiteCopy } from './ai.js';
import * as stripe from './stripe.js';
import { renderPortal, renderMessage } from './portal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'site'
  );
}

export function normalizeDomain(d) {
  return String(d || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

function readOrCreateSecret(file, bytes = 32) {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const value = crypto.randomBytes(bytes).toString('base64url');
  fs.writeFileSync(file, value, { mode: 0o600 });
  return value;
}

export function createApp({ dataDir = process.env.DATA_DIR || path.join(ROOT, 'data'), password, log = console.log } = {}) {
  const db = createDb(dataDir);
  const secret = process.env.SESSION_SECRET || readOrCreateSecret(path.join(dataDir, '.session-secret'));
  let adminPassword = password || process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    const pwFile = path.join(dataDir, '.admin-password');
    const existed = fs.existsSync(pwFile);
    adminPassword = readOrCreateSecret(pwFile, 9);
    if (!existed) log(`\n  No ADMIN_PASSWORD set. Generated one for you: ${adminPassword}\n  (saved in ${pwFile})\n`);
  }
  const auth = createAuth({ password: adminPassword, secret });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const settings = () => db.getSettings();
  const stripeKey = () => process.env.STRIPE_SECRET_KEY || settings().stripeSecretKey;
  const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET || settings().stripeWebhookSecret;
  const anthropicKey = () => process.env.ANTHROPIC_API_KEY || settings().anthropicApiKey;
  const baseUrl = (req) =>
    (process.env.BASE_URL || settings().baseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const adminHost = () => normalizeDomain(process.env.BASE_URL || settings().baseUrl);

  // ---- Stripe webhook needs the raw body, so it goes before the JSON parser.
  app.post('/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = req.body.toString('utf8');
    if (!stripe.verifyWebhook(raw, req.get('stripe-signature'), webhookSecret())) {
      return res.status(400).send('Bad signature');
    }
    handleStripeEvent(JSON.parse(raw));
    res.json({ received: true });
  });

  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // ---- Custom domains: a request whose Host matches a site's domain gets that site.
  app.use((req, res, next) => {
    const host = normalizeDomain(req.hostname);
    if (!host || host === adminHost() || host === 'localhost' || /^[\d.]+$/.test(host)) return next();
    const site = db.sites.find((s) => s.published && s.domain && normalizeDomain(s.domain) === host);
    if (!site) return next();
    if (req.method === 'GET' && req.path === '/') {
      return res.type('html').send(renderSite(site, { formAction: '/__form' }));
    }
    if (req.method === 'POST' && req.path === '/__form') return handleForm(site, req, res);
    if (req.path.startsWith('/uploads/')) return next();
    return res.redirect('/');
  });

  app.use('/uploads', express.static(db.uploadsDir, { maxAge: '7d', fallthrough: false }));

  // ---- Public hosted sites
  app.get('/s/:slug', (req, res) => {
    const site = db.sites.find((s) => s.slug === req.params.slug);
    const preview = site && !site.published && auth.isAuthed(req);
    if (!site || (!site.published && !preview)) {
      return res.status(404).type('html').send(renderMessage('Not found', 'This site does not exist or is not published yet.'));
    }
    res.type('html').send(renderSite(site, { formAction: `/s/${site.slug}/form`, preview }));
  });

  app.post('/s/:slug/form', (req, res) => {
    const site = db.sites.find((s) => s.slug === req.params.slug && s.published);
    if (!site) return res.status(404).json({ error: 'Not found' });
    handleForm(site, req, res);
  });

  const recentByIp = new Map();
  function handleForm(site, req, res) {
    const body = req.body || {};
    if (body.website) return res.json({ ok: true }); // honeypot field filled → bot
    const key = req.ip;
    const now = Date.now();
    const hits = (recentByIp.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (hits.length >= 5) return res.status(429).json({ error: 'Too many messages, try again later.' });
    hits.push(now);
    recentByIp.set(key, hits);

    const clip = (v, n = 2000) => String(v ?? '').slice(0, n);
    if (!clip(body.name).trim() || !clip(body.contact).trim()) {
      return res.status(400).json({ error: 'Name and contact are required.' });
    }
    db.submissions.insert({
      siteId: site.id,
      kind: body.kind === 'booking' ? 'booking' : 'contact',
      name: clip(body.name, 200),
      contact: clip(body.contact, 200),
      message: clip(body.message),
      date: clip(body.date, 20),
      time: clip(body.time, 20),
      service: clip(body.service, 200),
      read: false,
      status: 'new',
    });
    res.json({ ok: true });
  }

  // ---- Business-owner portal (secret link per site, no account needed)
  const siteByToken = (token) => db.sites.find((s) => s.ownerToken && s.ownerToken === token);

  app.get('/portal/:token', (req, res) => {
    const site = siteByToken(req.params.token);
    if (!site) return res.status(404).type('html').send(renderMessage('Not found', 'This link is not valid.'));
    res.type('html').send(
      renderPortal({
        site,
        siteUrl: siteUrl(site, req),
        submissions: db.submissions.filter((s) => s.siteId === site.id).slice(-25).reverse(),
        requests: db.requests.filter((r) => r.siteId === site.id).slice(-25).reverse(),
        stripeEnabled: Boolean(stripeKey()),
        flash: req.query.sent ? 'Thanks! Your request was sent.' : req.query.paid ? 'Payment received, thank you!' : '',
      }),
    );
  });

  app.post('/portal/:token/request', (req, res) => {
    const site = siteByToken(req.params.token);
    if (!site) return res.status(404).send('Not found');
    const text = String(req.body?.text || '').trim().slice(0, 4000);
    if (text) db.requests.insert({ siteId: site.id, text, status: 'open', reply: '' });
    res.redirect(303, `/portal/${site.ownerToken}?sent=1`);
  });

  app.post('/portal/:token/pay', async (req, res) => {
    const site = siteByToken(req.params.token);
    if (!site) return res.status(404).send('Not found');
    try {
      const session = await stripe.createCheckout({
        secretKey: stripeKey(),
        site,
        baseUrl: baseUrl(req),
        currency: settings().currency || 'usd',
      });
      db.sites.update(site.id, { billing: { ...site.billing, status: site.billing?.status === 'active' ? 'active' : 'pending' } });
      res.redirect(303, session.url);
    } catch (err) {
      res.status(400).type('html').send(renderMessage('Payment unavailable', err.message));
    }
  });

  app.post('/portal/:token/manage-billing', async (req, res) => {
    const site = siteByToken(req.params.token);
    if (!site?.billing?.stripeCustomerId) return res.status(404).send('Not found');
    try {
      const portal = await stripe.createPortalSession(stripeKey(), site.billing.stripeCustomerId, `${baseUrl(req)}/portal/${site.ownerToken}`);
      res.redirect(303, portal.url);
    } catch (err) {
      res.status(400).type('html').send(renderMessage('Billing unavailable', err.message));
    }
  });

  app.get('/pay/success', async (req, res) => {
    try {
      const session = await stripe.getCheckout(stripeKey(), String(req.query.session_id || ''));
      const site = recordCheckout(session);
      if (!site) throw new Error('Unknown site');
      res.redirect(303, `/portal/${site.ownerToken}?paid=1`);
    } catch (err) {
      res.status(400).type('html').send(renderMessage('Could not confirm payment', err.message));
    }
  });

  function recordCheckout(session) {
    const site = db.sites.get(session.client_reference_id || session.metadata?.site_id);
    if (!site) return null;
    const paid = session.status === 'complete' && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
    if (!paid) return site;
    if (!db.payments.find((p) => p.stripeSessionId === session.id)) {
      db.payments.insert({
        siteId: site.id,
        amount: (session.amount_total || 0) / 100,
        currency: session.currency,
        source: 'stripe',
        note: 'Checkout (build fee + first month)',
        stripeSessionId: session.id,
      });
    }
    db.sites.update(site.id, {
      billing: {
        ...site.billing,
        status: 'active',
        stripeCustomerId: session.customer || site.billing?.stripeCustomerId,
        stripeSubscriptionId: session.subscription || site.billing?.stripeSubscriptionId,
        paidAt: new Date().toISOString(),
      },
    });
    return site;
  }

  function handleStripeEvent(event) {
    const obj = event.data?.object || {};
    if (event.type === 'checkout.session.completed') recordCheckout(obj);
    if (event.type === 'invoice.paid' && obj.billing_reason === 'subscription_cycle') {
      const site = db.sites.find((s) => s.billing?.stripeSubscriptionId && s.billing.stripeSubscriptionId === obj.subscription);
      if (site && !db.payments.find((p) => p.stripeInvoiceId === obj.id)) {
        db.payments.insert({ siteId: site.id, amount: (obj.amount_paid || 0) / 100, currency: obj.currency, source: 'stripe', note: 'Monthly renewal', stripeInvoiceId: obj.id });
      }
    }
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const site = db.sites.find((s) => s.billing?.stripeSubscriptionId === obj.id);
      if (site) db.sites.update(site.id, { billing: { ...site.billing, status: mapSubStatus(obj.status) } });
    }
  }

  const mapSubStatus = (s) =>
    s === 'active' || s === 'trialing' ? 'active' : s === 'past_due' || s === 'unpaid' ? 'past_due' : s === 'canceled' ? 'canceled' : 'pending';

  function siteUrl(site, req) {
    if (site.domain) return `https://${normalizeDomain(site.domain)}`;
    return `${baseUrl(req)}/s/${site.slug}`;
  }

  // ---- Admin API
  const api = express.Router();
  api.post('/login', auth.login);
  api.post('/logout', auth.logout);
  api.get('/me', (req, res) => res.json({ authed: auth.isAuthed(req) }));
  api.use(auth.requireAuth);

  const mask = (v) => (v ? `••••${String(v).slice(-4)}` : '');
  api.get('/settings', (req, res) => {
    const s = settings();
    res.json({
      yourName: s.yourName || '',
      baseUrl: s.baseUrl || '',
      currency: s.currency || 'usd',
      defaultBuildFee: s.defaultBuildFee ?? 300,
      defaultMonthly: s.defaultMonthly ?? 49,
      stripeSecretKey: mask(stripeKey()),
      stripeWebhookSecret: mask(webhookSecret()),
      anthropicApiKey: mask(anthropicKey()),
      envOverrides: {
        stripeSecretKey: Boolean(process.env.STRIPE_SECRET_KEY),
        stripeWebhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
        anthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
        baseUrl: Boolean(process.env.BASE_URL),
      },
      webhookUrl: `${baseUrl(req)}/stripe/webhook`,
      serverIpHint: req.socket.localAddress,
    });
  });

  api.put('/settings', (req, res) => {
    const b = req.body || {};
    const patch = {};
    for (const k of ['yourName', 'baseUrl', 'currency']) if (k in b) patch[k] = String(b[k]).trim();
    for (const k of ['defaultBuildFee', 'defaultMonthly']) if (k in b) patch[k] = Number(b[k]) || 0;
    // Secrets: only overwrite when a new (unmasked) value is sent; empty string clears.
    for (const k of ['stripeSecretKey', 'stripeWebhookSecret', 'anthropicApiKey']) {
      if (k in b && !String(b[k]).startsWith('••••')) patch[k] = String(b[k]).trim();
    }
    db.setSettings(patch);
    res.json({ ok: true });
  });

  api.get('/stats', (req, res) => {
    const sites = db.sites.all();
    const active = sites.filter((s) => s.billing?.status === 'active');
    const leads = db.leads.all();
    res.json({
      leads: leads.length,
      leadsByStatus: leads.reduce((acc, l) => ((acc[l.status] = (acc[l.status] || 0) + 1), acc), {}),
      sites: sites.length,
      live: sites.filter((s) => s.published).length,
      paying: active.length,
      mrr: active.reduce((sum, s) => sum + (Number(s.billing?.monthly) || 0), 0),
      collected: db.payments.all().reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
      unreadSubmissions: db.submissions.filter((s) => !s.read).length,
      openRequests: db.requests.filter((r) => r.status === 'open').length,
      followUpsDue: leads.filter((l) => l.followUpAt && l.followUpAt <= new Date().toISOString().slice(0, 10) && !['won', 'lost'].includes(l.status)).length,
    });
  });

  // Leads
  const LEAD_FIELDS = ['osmId', 'name', 'category', 'lat', 'lon', 'address', 'phone', 'email', 'website', 'instagram', 'facebook', 'openingHours', 'status', 'notes', 'followUpAt', 'source'];
  const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in (obj || {})).map((k) => [k, obj[k]]));

  api.get('/leads', (req, res) => res.json(db.leads.all().slice().reverse()));
  api.post('/leads', (req, res) => {
    const data = pick(req.body, LEAD_FIELDS);
    if (!data.name) return res.status(400).json({ error: 'Name is required' });
    const existing = data.osmId && db.leads.find((l) => l.osmId === data.osmId);
    if (existing) return res.json({ ...existing, duplicate: true });
    res.json(db.leads.insert({ status: 'new', notes: '', source: data.osmId ? 'map' : 'manual', ...data }));
  });
  api.patch('/leads/:id', (req, res) => {
    const lead = db.leads.update(req.params.id, pick(req.body, LEAD_FIELDS));
    lead ? res.json(lead) : res.status(404).json({ error: 'Not found' });
  });
  api.delete('/leads/:id', (req, res) => res.json({ ok: db.leads.remove(req.params.id) }));

  api.post('/leads/:id/build', (req, res) => {
    const lead = db.leads.get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Not found' });
    const existing = db.sites.find((s) => s.leadId === lead.id);
    if (existing) return res.json(existing);
    const site = createSite({
      leadId: lead.id,
      business: {
        name: lead.name,
        category: lead.category,
        address: lead.address,
        phone: lead.phone,
        email: lead.email,
        instagram: lead.instagram,
        facebook: lead.facebook,
        lat: lead.lat,
        lon: lead.lon,
      },
      hoursText: lead.openingHours ? lead.openingHours.split(';').map((s) => s.trim()).join('\n') : '',
    });
    if (lead.status === 'new') db.leads.update(lead.id, { status: 'building' });
    res.json(site);
  });

  // Sites
  function uniqueSlug(base, ignoreId) {
    let slug = slugify(base);
    let n = 2;
    const root = slug;
    while (db.sites.find((s) => s.slug === slug && s.id !== ignoreId)) slug = `${root}-${n++}`;
    return slug;
  }

  function createSite(data) {
    const s = settings();
    return db.sites.insert({
      slug: uniqueSlug(data.business?.name),
      published: false,
      domain: '',
      template: 'classic',
      color: '#c2410c',
      business: { name: 'New business', tagline: '', about: '', category: '', address: '', phone: '', email: '', instagram: '', facebook: '', lat: '', lon: '' },
      hoursText: '',
      services: [],
      reviews: [],
      photos: [],
      features: { contactForm: true, booking: true, map: true },
      billing: { buildFee: s.defaultBuildFee ?? 300, monthly: s.defaultMonthly ?? 49, status: 'unpaid' },
      ownerToken: crypto.randomBytes(18).toString('base64url'),
      ownerEmail: '',
      notes: '',
      ...data,
    });
  }

  const SITE_FIELDS = ['slug', 'published', 'domain', 'template', 'color', 'business', 'hoursText', 'services', 'reviews', 'photos', 'features', 'billing', 'ownerEmail', 'notes', 'leadId'];

  api.get('/sites', (req, res) => res.json(db.sites.all().slice().reverse().map((s) => ({ ...s, url: siteUrl(s, req) }))));
  api.post('/sites', (req, res) => res.json(createSite(pick(req.body, SITE_FIELDS))));
  api.get('/sites/:id', (req, res) => {
    const site = db.sites.get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Not found' });
    res.json({ ...site, url: siteUrl(site, req), portalUrl: `${baseUrl(req)}/portal/${site.ownerToken}`, templates: TEMPLATE_NAMES });
  });
  api.patch('/sites/:id', (req, res) => {
    const site = db.sites.get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Not found' });
    const patch = pick(req.body, SITE_FIELDS);
    if ('slug' in patch) patch.slug = uniqueSlug(patch.slug || site.business?.name, site.id);
    if ('domain' in patch) {
      patch.domain = normalizeDomain(patch.domain);
      if (patch.domain && db.sites.find((s) => s.id !== site.id && normalizeDomain(s.domain) === patch.domain)) {
        return res.status(400).json({ error: 'Another site already uses that domain.' });
      }
    }
    if ('billing' in patch) {
      // Stripe-managed fields can't be overwritten from the editor.
      const keep = pick(site.billing, ['stripeCustomerId', 'stripeSubscriptionId', 'paidAt']);
      patch.billing = { ...site.billing, ...patch.billing, ...keep };
    }
    const updated = db.sites.update(site.id, patch);
    if (updated.published && updated.leadId) {
      const lead = db.leads.get(updated.leadId);
      if (lead && ['new', 'building'].includes(lead.status)) db.leads.update(lead.id, { status: 'pitched' });
    }
    res.json({ ...updated, url: siteUrl(updated, req) });
  });
  api.delete('/sites/:id', (req, res) => res.json({ ok: db.sites.remove(req.params.id) }));

  api.post('/sites/:id/preview', (req, res) => {
    // Render unsaved editor state so the preview updates live.
    const site = db.sites.get(req.params.id);
    if (!site) return res.status(404).send('Not found');
    res.type('html').send(renderSite({ ...site, ...pick(req.body, SITE_FIELDS) }, { preview: true }));
  });

  api.post('/sites/:id/rotate-portal', (req, res) => {
    const site = db.sites.update(req.params.id, { ownerToken: crypto.randomBytes(18).toString('base64url') });
    site ? res.json({ portalUrl: `${baseUrl(req)}/portal/${site.ownerToken}` }) : res.status(404).json({ error: 'Not found' });
  });

  api.post('/sites/:id/ai', async (req, res) => {
    const site = db.sites.get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Not found' });
    const draft = { ...site, ...pick(req.body, SITE_FIELDS) };
    try {
      const copy = await writeSiteCopy({
        apiKey: anthropicKey(),
        business: draft.business || {},
        services: draft.services,
        hoursText: draft.hoursText,
        reviews: draft.reviews,
        notes: draft.notes,
      });
      res.json(copy);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/sites/:id/checkout', async (req, res) => {
    const site = db.sites.get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Not found' });
    try {
      const session = await stripe.createCheckout({ secretKey: stripeKey(), site, baseUrl: baseUrl(req), currency: settings().currency || 'usd' });
      db.sites.update(site.id, { billing: { ...site.billing, status: site.billing?.status === 'active' ? 'active' : 'pending' } });
      res.json({ url: session.url });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/sites/:id/sync-billing', async (req, res) => {
    const site = db.sites.get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Not found' });
    if (!site.billing?.stripeSubscriptionId) return res.json(site);
    try {
      const sub = await stripe.getSubscription(stripeKey(), site.billing.stripeSubscriptionId);
      res.json(db.sites.update(site.id, { billing: { ...site.billing, status: mapSubStatus(sub.status) } }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.post('/sites/:id/cancel-subscription', async (req, res) => {
    const site = db.sites.get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Not found' });
    try {
      if (site.billing?.stripeSubscriptionId) await stripe.cancelSubscription(stripeKey(), site.billing.stripeSubscriptionId);
      res.json(db.sites.update(site.id, { billing: { ...site.billing, status: 'canceled' } }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Payments (Stripe ones are recorded automatically; cash/Venmo/etc. can be logged by hand)
  api.get('/payments', (req, res) => res.json(db.payments.all().slice().reverse()));
  api.post('/payments', (req, res) => {
    const site = db.sites.get(req.body?.siteId);
    if (!site) return res.status(400).json({ error: 'Pick a site' });
    const amount = Number(req.body.amount);
    if (!(amount > 0)) return res.status(400).json({ error: 'Enter an amount' });
    const p = db.payments.insert({ siteId: site.id, amount, currency: settings().currency || 'usd', source: 'manual', note: String(req.body.note || '').slice(0, 300) });
    if (req.body.markActive) db.sites.update(site.id, { billing: { ...site.billing, status: 'active', paidAt: p.createdAt } });
    res.json(p);
  });
  api.delete('/payments/:id', (req, res) => res.json({ ok: db.payments.remove(req.params.id) }));

  // Photo uploads arrive as data URLs from the browser.
  api.post('/upload', (req, res) => {
    const m = /^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/.exec(String(req.body?.dataUrl || ''));
    if (!m) return res.status(400).json({ error: 'Upload a PNG, JPEG, WebP or GIF image.' });
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    const name = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(db.uploadsDir, name), Buffer.from(m[3], 'base64'));
    res.json({ url: `/uploads/${name}` });
  });

  // Inbox
  api.get('/inbox', (req, res) => {
    const names = Object.fromEntries(db.sites.all().map((s) => [s.id, s.business?.name || s.slug]));
    res.json({
      submissions: db.submissions.all().slice().reverse().map((s) => ({ ...s, siteName: names[s.siteId] })),
      requests: db.requests.all().slice().reverse().map((r) => ({ ...r, siteName: names[r.siteId] })),
    });
  });
  api.patch('/submissions/:id', (req, res) => res.json(db.submissions.update(req.params.id, pick(req.body, ['read', 'status']))));
  api.delete('/submissions/:id', (req, res) => res.json({ ok: db.submissions.remove(req.params.id) }));
  api.patch('/requests/:id', (req, res) => res.json(db.requests.update(req.params.id, pick(req.body, ['status', 'reply']))));
  api.delete('/requests/:id', (req, res) => res.json({ ok: db.requests.remove(req.params.id) }));

  api.get('/export', (req, res) => {
    db.flush();
    res.setHeader('Content-Disposition', `attachment; filename="pindrop-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.type('json').send(fs.readFileSync(path.join(dataDir, 'db.json')));
  });

  app.use('/api', api);
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

  app.use((err, req, res, _next) => {
    log(err);
    if (req.path.startsWith('/api')) return res.status(500).json({ error: err.message });
    res.status(500).type('html').send(renderMessage('Error', err.message));
  });

  return { app, db };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Pindrop (personal) running at http://localhost:${port}`));
}
