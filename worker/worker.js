// CAST/SOFT shared bookings backend
//
// Cloudflare Worker + KV that makes consultation bookings persistent and
// shared across all visitors (instead of each browser's localStorage).
//
// Endpoints:
//   GET    /bookings          -> { ok, bookings: [...] }
//   POST   /bookings          -> { ok, booking }  (409 if slot already taken)
//   DELETE /bookings/:id      -> { ok }
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
        return deleteBooking(env, decodeURIComponent(match[1]), corsHeaders);
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

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}
