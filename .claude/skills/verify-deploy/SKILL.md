---
name: verify-deploy
description: Check what production is serving versus HEAD and main, and whether Vercel's build for HEAD succeeded. Use after any push, when asked "is it live", or before promoting to production.
allowed-tools: Bash(node scripts/deploy-status.mjs *) Bash(git *) Bash(curl *)
---

## Current state

!`node ${CLAUDE_PROJECT_DIR}/scripts/deploy-status.mjs 2>&1 || true`

## How to read it

- **Production follows `main`.** A push to any other branch builds a *preview* only; production
  changes when `main` moves. If `HEAD is live: no` but `build … success`, the commit is fine and
  simply not promoted — use `/promote`.
- `production` shows the commit the live function was built from (`/api/health` → `deploy.commit`).
  A healthy response alone proves nothing: Vercel keeps the previous deployment serving when a build
  fails. Only the commit match proves the new build is live.
- Three Vercel projects are linked to this repo. `cloud-miner-value-dashboard` is the real one.
  `cloud-miner-value-dashboard-cr1b` duplicates it and `segments-mining-dashboard` fails every build;
  both should be unlinked in the Vercel dashboard. Ignore their statuses.
- Preview URLs are Vercel-authenticated (302 for anonymous curl). The owner can open them; the
  GitHub deployment status carries the URL when it is needed.

Report the four facts plainly: branch/HEAD, remote main, production commit, build status. Do not
claim a deployment succeeded without the commit match.
