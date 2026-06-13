// Super Snoopers — serverless matchmaking / room registry (Vercel + Upstash Redis).
//
// Gameplay itself is peer-to-peer (WebRTC via PeerJS). This API only tracks the
// list of live public rooms + their player counts so Quick Match can find a
// joinable room anywhere in the world and the 5-player cap is enforced globally.
//
// Rooms self-expire via a short TTL: a host heartbeats every few seconds; if it
// stops (left / crashed), the room entry vanishes automatically.
//
// Env (auto-set by the Upstash integration on Vercel):
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

import { Redis } from '@upstash/redis';

const MAX = 5;     // max players per room
const TTL = 15;    // seconds a room lives without a heartbeat

let redis = null;
function db() {
  if (!redis) redis = Redis.fromEnv();
  return redis;
}

export default async function handler(req, res) {
  // body may be a string on some runtimes
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const action = req.query.action || body.action;

  // matchmaking DB not configured yet → degrade gracefully (no 500 spam).
  // The client then just hosts/join-by-code. Add Upstash on Vercel to enable.
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    if (action === 'find') return res.status(200).json({ code: null, disabled: true });
    if (action === 'list') return res.status(200).json({ rooms: [], disabled: true });
    return res.status(200).json({ ok: false, disabled: true });
  }

  try {
    const r = db();

    if (action === 'find') {
      const keys = await r.keys('room:*');
      let best = null;
      for (const k of keys) {
        const v = await r.get(k);
        const count = v && typeof v.count === 'number' ? v.count : 0;
        if (count > 0 && count < MAX) {            // joinable: not empty, not full
          if (!best || count > best.count) best = { code: k.slice(5), count };
        }
      }
      return res.status(200).json({ code: best ? best.code : null, max: MAX });
    }

    if (action === 'register' || action === 'heartbeat') {
      const code = (body.code || '').toUpperCase();
      const count = Math.max(0, Math.min(MAX, body.count | 0));
      if (!code) return res.status(400).json({ error: 'missing code' });
      await r.set('room:' + code, { count }, { ex: TTL });
      return res.status(200).json({ ok: true, full: count >= MAX });
    }

    if (action === 'leave') {
      const code = (body.code || '').toUpperCase();
      if (code) await r.del('room:' + code);
      return res.status(200).json({ ok: true });
    }

    if (action === 'list') {
      const keys = await r.keys('room:*');
      const rooms = [];
      for (const k of keys) { const v = await r.get(k); rooms.push({ code: k.slice(5), count: (v && v.count) || 0 }); }
      return res.status(200).json({ rooms, max: MAX });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
}
