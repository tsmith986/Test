// Single-password admin auth using an HMAC-signed cookie. No user table needed.
import crypto from 'node:crypto';

const COOKIE = 'pd_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function createAuth({ password, secret }) {
  function isAuthed(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return false;
    const [expires, sig] = token.split('.');
    if (!expires || !sig || !safeEqual(sig, sign(expires, secret))) return false;
    return Number(expires) > Date.now();
  }

  function login(req, res) {
    const given = String(req.body?.password ?? '');
    const ok =
      given.length > 0 &&
      safeEqual(sign(given, secret), sign(password, secret));
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    const expires = String(Date.now() + MAX_AGE_MS);
    const secure = req.secure ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${expires}.${sign(expires, secret)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_MS / 1000}${secure}`,
    );
    res.json({ ok: true });
  }

  function logout(_req, res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  }

  function requireAuth(req, res, next) {
    if (isAuthed(req)) return next();
    res.status(401).json({ error: 'Not logged in' });
  }

  return { isAuthed, login, logout, requireAuth };
}
