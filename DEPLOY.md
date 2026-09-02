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
