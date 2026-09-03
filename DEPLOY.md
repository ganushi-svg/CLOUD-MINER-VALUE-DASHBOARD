# Deploying the Ops Center to Vercel

**Live:** https://cloud-miner-value-dashboard.vercel.app · Vercel project
`cloud-miner-value-dashboard` (team `ganushi-s-projects`), git-linked to this repository.
This repository is the standalone home of the product; the code sits at the repository
root, so no Root Directory is set. Every push to the linked branch redeploys.

This repository is a **standalone Vercel project** with zero runtime dependencies.

## Project settings

| Setting | Value |
| --- | --- |
| Repository | `ganushi-svg/CLOUD-MINER-VALUE-DASHBOARD` |
| Branch | `claude/segments-cloud-ops-center-mfsuxv` (production follows `main` once merged) |
| Root Directory | *(leave empty — code is at the repository root)* |
| Framework preset | Other |
| Build command | *(leave empty)* |
| Install command | *(leave empty — zero runtime dependencies)* |
| Output directory | `public` |
| Node version | 20.x or later |

Serverless functions are auto-detected from `api/*.js`.

## Environment variables

None are required. The service deploys and serves correctly with no
configuration, because it ships with a verbatim snapshot of the source sheet.

To read the sheet live instead, set `GOOGLE_SERVICE_ACCOUNT` to a service-account
JSON and share the spreadsheet with its `client_email` as Viewer. The connector
chain prefers it automatically — no code change and no redeploy logic. See
`.env.example`.

## Before making the URL public — read this

`/api/dataset` returns **98 named clients with their unit counts and dollar
valuations**. Milestone 1 has no authentication; that arrives in Milestone 10.

Until then, keep Vercel Deployment Protection on:

> Project → Settings → Deployment Protection → **Vercel Authentication: All Deployments**

**Status at 2026-09-02: protection is OFF** — the production URL answers without
authentication. It could not be enabled through the Vercel MCP integration because that
integration's grant only covers the three projects that existed when it was authorised;
the API returns *404 Project not found* for projects created after that authorisation. Either enable protection in the Vercel dashboard
directly, or widen the Claude integration's project access (Vercel → Settings →
Integrations → Claude → Manage Access → *All projects*) so it can be managed
from here. New projects inherit the team's default protection, so verify rather than assume.
If the URL must be shared outside the Vercel team, use Password Protection or
Trusted IPs rather than turning protection off.

## Supplier price feed and the WhatsApp webhook

**What WhatsApp allows.** Meta's Cloud API delivers messages sent *to your WhatsApp
Business number*. It cannot read a supplier group that a personal number belongs to,
and the unofficial libraries that can (Baileys, whatsapp-web.js) get business accounts
banned. So the supported flow is: a designated colleague forwards the day's price list
from the group to the business number, or the supplier is asked to post to it directly.
`WHATSAPP_ALLOWED_SENDERS` is the "one group" control — only those numbers feed prices.

**Set-up (about 20 minutes, once).**

1. [developers.facebook.com](https://developers.facebook.com) → *Create App* → type *Business*
   → add the **WhatsApp** product. Note the *Phone number ID* and, under *App settings →
   Basic*, the **App Secret**.
2. In Vercel → project → *Settings → Environment Variables* add `WHATSAPP_APP_SECRET`,
   a `WHATSAPP_VERIFY_TOKEN` of your choosing, and `WHATSAPP_ALLOWED_SENDERS`
   (digits only, e.g. `9715xxxxxxxx`). Redeploy.
3. Meta app → *WhatsApp → Configuration → Webhook*: callback URL
   `https://cloud-miner-value-dashboard.vercel.app/api/whatsapp`, verify token as above,
   then subscribe to the **messages** field. Meta calls `GET /api/whatsapp` for the
   handshake; the endpoint answers only when the token matches.
4. Send a test list to the business number. `GET /api/pricefeed` shows what was parsed;
   the **Price feed** tab shows it against the sheet's quotes.

Every delivery is verified with `X-Hub-Signature-256` (HMAC over the raw body); an
unsigned or tampered request is rejected before parsing. Image and PDF price lists are
acknowledged but not parsed — only text and captions are. OCR is a later addition.

**Without WhatsApp.** `POST /api/pricefeed` with `Authorization: Bearer
$PRICEFEED_INGEST_SECRET` and `{ "text": "...", "source": "..." }` runs the identical
parser — usable from an email-forwarding rule, a script, or a paste.

**Durability.** The default store is function memory: fine for a trial, gone on the next
cold start, and labelled *not durable* in the UI. The recommended store is the Segments
Cloud Supabase project, where the migration `ops_pricefeed_observations_and_event_states`
(source: `db/ops_pricefeed.sql`) has already created two tables with row-level security
on and no policies — only a secret key can touch them. Set, in Vercel:

| Variable | Value |
| --- | --- |
| `PRICEFEED_STORE` | `supabase` |
| `SUPABASE_URL` | the project URL, `https://<project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Supabase Dashboard → Project Settings → API Keys → a **secret** key (`sb_secret_…`; the legacy `service_role` JWT also works). Never the publishable/anon key, which RLS blocks by design. |

With that in place `/api/pricefeed` reports `store.kind = "supabase"`, the *not durable*
warning in the attention feed clears (and shows as a RECOVERY for a day), price
history accumulates per model for the sparklines, and `/api/events` remembers
alerting states between runs so a cleared WARNING/CRITICAL is reported as RECOVERY.
If the variables are set but wrong, the store falls back to memory and the attention
feed names the store that was asked for. `PRICEFEED_STORE=sheet` (with the service
account) remains available as the workbook-tab alternative.

## Verifying a deployment

`GET /api/health` should return exactly these figures — they are the same numbers
`node scripts/ingest.mjs` prints locally, so any drift means the deployed bundle
does not match the snapshot:

```
units 1395 · hashrateTh 399850.5 · powerKw 6331.6
usedValueMinor 169731180 · freshValueMinor 229470110
models 24 · clients 98 · holdings 147 · workers 225
validation.ok true · CRITICAL 0 · WARNING 4 · INFO 8
```

The root URL serves a status page rendering the same figures and the full
data-quality findings list.
