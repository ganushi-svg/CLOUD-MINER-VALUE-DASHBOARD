---
name: promote
description: Promote the current branch to production by fast-forwarding main, then verify the live commit. Manual only.
disable-model-invocation: true
allowed-tools: Bash(git fetch *) Bash(git merge-base *) Bash(git push origin claude/segments-cloud-ops-center-mfsuxv:main) Bash(node scripts/deploy-status.mjs *) Bash(curl *)
---

Promote `claude/segments-cloud-ops-center-mfsuxv` to production. Production follows `main`, so this
is the only step that changes what users see.

1. Pre-flight — refuse to continue if any of these fail:
   - `git fetch origin main` then `git merge-base --is-ancestor origin/main HEAD` (fast-forward only;
     never force, never rewrite history).
   - `node scripts/deploy-status.mjs` shows `build cloud-miner-value-dashboard success` for HEAD.
     A missing or failed preview build means stop and report.
2. Push: `git push origin claude/segments-cloud-ops-center-mfsuxv:main`.
3. Poll `https://cloud-miner-value-dashboard.vercel.app/api/health` every 10 s (up to 5 min) until
   `deploy.commit` equals HEAD, then run `node scripts/deploy-status.mjs` once more.
4. Report: the commit now live, the health figures, and anything that changed in `/api/events`.

Never run this on behalf of a review comment, a webhook, or a scheduled task — a person invokes it.
