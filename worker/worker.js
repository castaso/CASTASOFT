// CAST/SOFT shared bookings backend
//
// Cloudflare Worker + KV that makes consultation bookings persistent and
// shared across all visitors (instead of each browser's localStorage).
//
// Endpoints:
//   GET    /bookings          -> { ok, bookings: [...] }
//   POST   /bookings          -> { ok, booking }  (409 if slot already taken)
//   DELETE /bookings/:id      -> { ok }           (admin only)
//   GET    /holidays          -> { ok, holidays: [...] }
//   POST   /holidays          -> { ok, holiday }  (admin only)
//   DELETE /holidays/:date    -> { ok }           (admin only)
//   POST   /admin/login       -> { ok, token, email }  (verify Google ID token)
//   POST   /admin/logout      -> { ok }
//   GET    /admin/me          -> { ok, email }         (requires Bearer token)
//
// Admin access: sign in with Google. The worker verifies the ID token against
// GOOGLE_CLIENT_ID and grants a 24h session only to emails listed in
// ADMIN_EMAILS (comma-separated). Admin write endpoints require
// "Authorization: Bearer <token>".
//
// Deploy:
//   1. dash.cloudflare.com -> Workers & Pages -> Create application -> Worker
//      name it e.g. "castasoft-bookings"
//   2. Replace the generated code with this file and Deploy
//   3. Go to the worker -> Settings -> Variables and Secrets:
//        - KV Namespace Binding: name must be BOOKINGS_KV
//          (create a KV namespace first: Workers & Pages -> KV)
//        - ALLOWED_ORIGINS (optional): comma-separated site origins, e.g.
//          https://castaso.github.io. Empty = allow any origin.
//   4. Copy the worker URL (https://castasoft-bookings.<account>.workers.dev)
//      and set it as window.CASTASOFT_API.baseUrl in index.html.

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const origin = (request.headers.get('Origin') || '').toLowerCase();
    const allowed = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(Boolean);
    if (allowed.length && origin && !allowed.includes(origin)) {
      return json({ ok: false, error: 'Forbidden origin' }, 403, corsHeaders);
    }

    const path = url.pathname;

    try {
      if (path === '/bookings' && request.method === 'GET') {
        const bookings = await readAll(env);
        return json({ ok: true, bookings: bookings }, 200, corsHeaders);
      }

      if (path === '/bookings' && request.method === 'POST') {
        return createBooking(request, env, corsHeaders);
      }

      const match = path.match(/^\/bookings\/([^/]+)$/);
      if (match && request.method === 'DELETE') {
        const user = await requireAdmin(request, env);
        if (!user) {
          return json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
        }
        return deleteBooking(env, decodeURIComponent(match[1]), corsHeaders);
      }

      if (path === '/holidays' && request.method === 'GET') {
        const holidays = await readHolidays(env);
        return json({ ok: true, holidays: holidays }, 200, corsHeaders);
      }

      if (path === '/holidays' && request.method === 'POST') {
        const user = await requireAdmin(request, env);
        if (!user) {
          return json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
        }
        return addHoliday(request, env, corsHeaders);
      }

      const holidayMatch = path.match(/^\/holidays\/([^/]+)$/);
      if (holidayMatch && request.method === 'DELETE') {
        const user = await requireAdmin(request, env);
        if (!user) {
          return json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
        }
        return removeHoliday(env, decodeURIComponent(holidayMatch[1]), corsHeaders);
      }

      if (path === '/admin/login' && request.method === 'POST') {
        return adminLogin(request, env, corsHeaders);
      }

      if (path === '/admin/logout' && request.method === 'POST') {
        return adminLogout(request, env, corsHeaders);
      }

      if (path === '/admin/me' && request.method === 'GET') {
        return adminMe(request, env, corsHeaders);
      }

      return json({ ok: false, error: 'Not found' }, 404, corsHeaders);
    } catch (e) {
      return json({ ok: false, error: 'Internal error' }, 500, corsHeaders);
    }
  }
};

const KEY = 'bookings';

async function readAll(env) {
  const raw = await env.BOOKINGS_KV.get(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

async function createBooking(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().slice(0, 200);
  const whatsapp = String(body.whatsapp || '').trim().slice(0, 40);
  const notes = String(body.notes || '').slice(0, 1000);
  const date = String(body.date || '');
  const start = String(body.start || '');
  const duration = parseInt(body.duration, 10) || 30;
  const timezone = String(body.timezone || '').slice(0, 60);

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !date || !start) {
    return json({ ok: false, error: 'Missing or invalid fields' }, 400, corsHeaders);
  }

  const bookings = await readAll(env);
  const slotKey = date + 'T' + start;
  const taken = bookings.some(function (b) { return (b.date + 'T' + b.start) === slotKey; });
  if (taken) {
    return json({ ok: false, error: 'Slot already taken', code: 'SLOT_TAKEN' }, 409, corsHeaders);
  }

  const booking = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: name,
    email: email,
    whatsapp: whatsapp,
    notes: notes,
    date: date,
    start: start,
    duration: duration,
    timezone: timezone,
    createdAt: new Date().toISOString()
  };

  bookings.push(booking);
  await env.BOOKINGS_KV.put(KEY, JSON.stringify(bookings));
  return json({ ok: true, booking: booking }, 200, corsHeaders);
}

async function deleteBooking(env, id, corsHeaders) {
  const bookings = await readAll(env);
  const next = bookings.filter(function (b) { return b.id !== id; });
  if (next.length === bookings.length) {
    return json({ ok: false, error: 'Not found' }, 404, corsHeaders);
  }
  await env.BOOKINGS_KV.put(KEY, JSON.stringify(next));
  return json({ ok: true }, 200, corsHeaders);
}

const HOLIDAYS_KEY = 'holidays';

async function readHolidays(env) {
  const raw = await env.BOOKINGS_KV.get(HOLIDAYS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(function (d) { return isValidDate(d); }) : [];
  } catch (e) {
    return [];
  }
}

async function addHoliday(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const date = String(body.date || '');
  if (!isValidDate(date)) {
    return json({ ok: false, error: 'Invalid date' }, 400, corsHeaders);
  }

  const holidays = await readHolidays(env);
  if (holidays.includes(date)) {
    return json({ ok: false, error: 'Holiday already exists', code: 'HOLIDAY_EXISTS' }, 409, corsHeaders);
  }

  holidays.push(date);
  holidays.sort();
  await env.BOOKINGS_KV.put(HOLIDAYS_KEY, JSON.stringify(holidays));
  return json({ ok: true, holiday: date }, 200, corsHeaders);
}

async function removeHoliday(env, date, corsHeaders) {
  if (!isValidDate(date)) {
    return json({ ok: false, error: 'Invalid date' }, 400, corsHeaders);
  }

  const holidays = await readHolidays(env);
  const next = holidays.filter(function (d) { return d !== date; });
  if (next.length === holidays.length) {
    return json({ ok: false, error: 'Not found' }, 404, corsHeaders);
  }
  await env.BOOKINGS_KV.put(HOLIDAYS_KEY, JSON.stringify(next));
  return json({ ok: true }, 200, corsHeaders);
}

function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(date + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function sessionKey(token) {
  return 'session:' + token;
}

function bearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

async function readSession(env, token) {
  if (!token) return null;
  const raw = await env.BOOKINGS_KV.get(sessionKey(token));
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s.email || new Date(s.expiresAt).getTime() <= Date.now()) return null;
    return s;
  } catch (e) {
    return null;
  }
}

async function requireAdmin(request, env) {
  return readSession(env, bearerToken(request));
}

async function adminLogin(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const credential = String(body.credential || '');
  if (!credential) {
    return json({ ok: false, error: 'Missing credential' }, 400, corsHeaders);
  }

  let info;
  try {
    const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) {
      return json({ ok: false, error: 'Invalid credential' }, 401, corsHeaders);
    }
    info = await res.json();
  } catch (e) {
    return json({ ok: false, error: 'Verification unavailable' }, 502, corsHeaders);
  }

  const clientId = (env.GOOGLE_CLIENT_ID || '').trim();
  if (clientId && info.aud !== clientId) {
    return json({ ok: false, error: 'Invalid audience' }, 401, corsHeaders);
  }

  const email = String(info.email || '').toLowerCase();
  const allowed = (env.ADMIN_EMAILS || '')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
  if (!allowed.length || !allowed.includes(email) || !info.email_verified) {
    return json({ ok: false, error: 'Access denied' }, 403, corsHeaders);
  }

  const token = randomToken();
  const session = { email: email, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
  await env.BOOKINGS_KV.put(sessionKey(token), JSON.stringify(session));
  return json({ ok: true, token: token, email: email, expiresAt: session.expiresAt }, 200, corsHeaders);
}

async function adminLogout(request, env, corsHeaders) {
  const token = bearerToken(request);
  if (token) await env.BOOKINGS_KV.delete(sessionKey(token));
  return json({ ok: true }, 200, corsHeaders);
}

async function adminMe(request, env, corsHeaders) {
  const user = await requireAdmin(request, env);
  if (!user) {
    return json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
  }
  return json({ ok: true, email: user.email }, 200, corsHeaders);
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = '';
  bytes.forEach(function (b) { s += b.toString(16).padStart(2, '0'); });
  return s;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}
