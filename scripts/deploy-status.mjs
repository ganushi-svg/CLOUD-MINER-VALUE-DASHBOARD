#!/usr/bin/env node
// Where is every commit? Local HEAD, remote main, what production actually
// serves (from /api/health's build provenance), and Vercel's build status for
// HEAD as recorded on GitHub (public repo -> no token needed).
import { execSync } from 'node:child_process';
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const REPO = 'ganushi-svg/CLOUD-MINER-VALUE-DASHBOARD';
const PROD = process.env.PROD_URL || 'https://cloud-miner-value-dashboard.vercel.app';
const head = sh('git rev-parse HEAD'), short = head.slice(0, 7);
const branch = sh('git rev-parse --abbrev-ref HEAD');
let remoteMain = 'unknown';
try { remoteMain = sh('git ls-remote --heads origin main').slice(0, 7); } catch {}
const get = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(15000) }); return r.ok ? r.json() : { _http: r.status }; } catch (e) { return { _err: e.message }; } };
const health = await get(`${PROD}/api/health`);
const status = await get(`https://api.github.com/repos/${REPO}/commits/${head}/status`);
const deps = await get(`https://api.github.com/repos/${REPO}/deployments?sha=${head}&per_page=10`);
console.log(`branch        ${branch} @ ${short}`);
console.log(`remote main   ${remoteMain}${remoteMain === short ? '  (== HEAD)' : ''}`);
console.log(`production    ${health.deploy?.commit ? health.deploy.commit.slice(0, 7) + ' (' + health.deploy.ref + ', ' + health.deploy.env + ')' : 'unreadable: ' + JSON.stringify(health).slice(0, 80)}`);
console.log(`prod health   ${health.ok === true ? 'ok' : 'NOT OK'}  units=${health.fleet?.units ?? '?'}  validation=${JSON.stringify(health.validation?.counts ?? {})}`);
console.log(`HEAD is live  ${health.deploy?.commit === head ? 'YES' : 'no'}`);
const vercel = (status.statuses ?? []).filter((s) => s.context.startsWith('Vercel'));
for (const s of vercel) console.log(`build         ${s.context.replace('Vercel – ', '').padEnd(36)} ${s.state}`);
for (const d of Array.isArray(deps) ? deps : []) console.log(`deployment    ${String(d.environment).padEnd(45)} ${d.created_at}`);
if (!vercel.length) console.log('build         no Vercel status on GitHub for HEAD yet');
