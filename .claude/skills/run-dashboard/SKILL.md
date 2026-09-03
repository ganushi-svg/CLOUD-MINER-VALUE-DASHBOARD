---
name: run-dashboard
description: Launch the Ops Command Center locally and render it. Use when asked to run, start, screenshot, or visually check the dashboard, or to confirm a UI change works in the real page rather than in tests.
allowed-tools: Bash(node scripts/serve.mjs *) Bash(curl *) Bash(/opt/pw-browsers/*)
---

Launch recipe (no install step; zero build):

```bash
INGEST_SOURCES=fixture PORT=3000 PRICEFEED_INGEST_SECRET=dev node scripts/serve.mjs &
sleep 1.2
curl -s localhost:3000/api/health | head -c 300
```

Seed the price feed so the Price feed tab and Attention strip have content:

```bash
curl -s -X POST localhost:3000/api/pricefeed -H 'authorization: Bearer dev' -H 'content-type: application/json' \
  -d '{"text":"S21+ 235T $1,269 used\nS19k pro 120T 380 usd\nS21 XP Hyd 473T $2850 new","source":"local-test"}'
```

Screenshot with the pre-installed headless Chromium (Playwright's npm package is not installed; the
binary is). Tabs are hash-routed: `/#fleet`, `/#pricefeed`, etc.

```bash
/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell --no-sandbox --disable-gpu \
  --hide-scrollbars --virtual-time-budget=6000 --run-all-compositor-stages-before-draw \
  --default-background-color=0A1020FF --window-size=1440,900 --screenshot=/tmp/shot.png "http://localhost:3000/#pricefeed"
```

Then Read the PNG and check: the white wordmark renders in the header, tab counts appear, no label
collisions, tables scroll inside their cards rather than the page. Kill the server when done.

Known limits: screenshots of the *live* Vercel URL fail from this container (the egress proxy resets
Chromium's TLS handshake); verify production with curl or `/verify-deploy` instead.
