// WhatsApp Business Platform (Meta Cloud API) webhook.
//
// What this can and cannot do, stated plainly: the Cloud API delivers messages
// sent TO your WhatsApp Business number. It does not read a supplier group that
// a personal number belongs to, and the unofficial libraries that can are a
// ban risk for a business account. So the flow is: a designated person forwards
// the day's price list from the group to the business number (or the supplier
// posts to it directly), Meta calls this endpoint, and the list is parsed into
// the price feed. WHATSAPP_ALLOWED_SENDERS is the "one group" control: only
// messages from those numbers are ingested; everything else is acknowledged
// and dropped.
//
// Uses the Web-standard handler signature so the raw body is available for
// signature verification — the HMAC must be computed over the exact bytes.
import crypto from 'node:crypto';
import { ingestText } from '../src/pricefeed/ingest.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Verification handshake Meta performs when you register the webhook URL. */
export async function GET(request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!expected) return json(503, { error: 'webhook_disabled', detail: 'WHATSAPP_VERIFY_TOKEN is not set' });
  if (mode === 'subscribe' && token && safeEqual(token, expected) && challenge) {
    return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  return json(403, { error: 'verification_failed' });
}

/** Inbound message notifications. */
export async function POST(request) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return json(503, { error: 'webhook_disabled', detail: 'WHATSAPP_APP_SECRET is not set' });

  const raw = await request.text();
  const signature = request.headers.get('x-hub-signature-256') ?? '';
  if (!verifySignature(raw, signature, secret)) return json(401, { error: 'bad_signature' });

  let payload;
  try { payload = JSON.parse(raw); } catch { return json(400, { error: 'bad_json' }); }
  if (payload?.object !== 'whatsapp_business_account') return json(200, { ignored: 'not_whatsapp' });

  const allowed = (process.env.WHATSAPP_ALLOWED_SENDERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneNumberId = value.metadata?.phone_number_id ?? 'unknown';
      for (const msg of value.messages ?? []) {
        const from = String(msg.from ?? '');
        if (allowed.length && !allowed.includes(from)) { results.push({ id: msg.id, skipped: 'sender_not_allowed' }); continue; }
        const observedAt = msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : new Date().toISOString();
        const text = msg.type === 'text' ? msg.text?.body
          : ['image', 'document'].includes(msg.type) ? msg[msg.type]?.caption : null;
        if (!text) { results.push({ id: msg.id, skipped: `${msg.type}_not_parsed` }); continue; }
        try {
          const r = await ingestText({ text, source: `whatsapp:${phoneNumberId}`, sender: from, observedAt, messageId: msg.id });
          results.push({ id: msg.id, parsed: r.parsed, added: r.added, duplicates: r.duplicates, unresolved: r.unresolved.length, store: r.store.kind });
        } catch (err) {
          results.push({ id: msg.id, error: err.message });
        }
      }
    }
  }
  // Always 200 once the signature checks out: Meta retries non-2xx responses.
  return json(200, { received: results.length, results });
}

export function verifySignature(rawBody, header, secret) {
  const m = /^sha256=([a-f0-9]{64})$/i.exec(header);
  if (!m) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return safeEqual(m[1].toLowerCase(), expected);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
