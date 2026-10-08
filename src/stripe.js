// Minimal Stripe client over the REST API. Payments go straight into your own
// Stripe account: a one-time build fee plus a monthly subscription per site.
import crypto from 'node:crypto';

const API = 'https://api.stripe.com/v1';

function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

async function call(secretKey, method, path, body) {
  if (!secretKey) throw new Error('Add your Stripe secret key in Settings first.');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? formEncode(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `Stripe error ${res.status}`);
  return json;
}

const cents = (dollars) => Math.round(Number(dollars || 0) * 100);

export async function createCheckout({ secretKey, site, baseUrl, currency = 'usd' }) {
  const name = site.business?.name || 'Website';
  const lineItems = [];
  if (cents(site.billing?.monthly) > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency,
        unit_amount: cents(site.billing.monthly),
        recurring: { interval: 'month' },
        product_data: { name: `${name} – website hosting & care` },
      },
    });
  }
  if (cents(site.billing?.buildFee) > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency,
        unit_amount: cents(site.billing.buildFee),
        product_data: { name: `${name} – website build (one-time)` },
      },
    });
  }
  if (!lineItems.length) throw new Error('Set a build fee and/or monthly price first.');

  const hasSubscription = cents(site.billing?.monthly) > 0;
  const params = {
    mode: hasSubscription ? 'subscription' : 'payment',
    success_url: `${baseUrl}/pay/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/portal/${site.ownerToken}`,
    client_reference_id: site.id,
    metadata: { site_id: site.id },
    line_items: lineItems,
  };
  if (hasSubscription) params.subscription_data = { metadata: { site_id: site.id } };
  if (site.ownerEmail) params.customer_email = site.ownerEmail;
  return call(secretKey, 'POST', '/checkout/sessions', params);
}

export const getCheckout = (secretKey, id) =>
  call(secretKey, 'GET', `/checkout/sessions/${encodeURIComponent(id)}`);

export const getSubscription = (secretKey, id) =>
  call(secretKey, 'GET', `/subscriptions/${encodeURIComponent(id)}`);

export const cancelSubscription = (secretKey, id) =>
  call(secretKey, 'DELETE', `/subscriptions/${encodeURIComponent(id)}`);

export function createPortalSession(secretKey, customer, returnUrl) {
  return call(secretKey, 'POST', '/billing_portal/sessions', { customer, return_url: returnUrl });
}

// Verifies the Stripe-Signature header (see Stripe's "manually verify" docs).
export function verifyWebhook(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const sigs = header
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some(
    (s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)),
  );
}
