#!/usr/bin/env node
// Local dev server that mounts the api/ handlers the same way Vercel does,
// so the routes can be exercised before deploying.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT ?? 3000);
const root = new URL('../', import.meta.url);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, '');
      const mod = await import(new URL(`api/${name}.js`, root));
      const web = mod[req.method];
      if (typeof web === 'function') {
        // Web-standard signature: (Request) => Response, as Vercel's Node runtime supports.
        const chunks = []; for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
        const response = await web(request);
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        return res.end(Buffer.from(await response.arrayBuffer()));
      }
      const handler = mod.default;
      // Mirror what Vercel's Node helpers provide: headers, parsed JSON body, query.
      const chunks = []; for await (const c of req) chunks.push(c);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body = rawBody;
      if (/application\/json/i.test(req.headers['content-type'] ?? '') && rawBody) { try { body = JSON.parse(rawBody); } catch { /* leave as string */ } }
      const shim = {
        status(code) { res.statusCode = code; return shim; },
        json(payload) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(payload, null, 2)); return shim; },
      };
      return handler({ method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers, body }, shim);
    }
    const file = url.pathname === '/' ? 'public/index.html' : `public${url.pathname}`;
    const body = await readFile(fileURLToPath(new URL(file, root)));
    const ext = file.slice(file.lastIndexOf('.') + 1);
    const MIME = { html: 'text/html; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', css: 'text/css', js: 'text/javascript', json: 'application/json', ico: 'image/x-icon' };
    res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
    res.end(body);
  } catch (err) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', detail: err.message }));
  }
});
server.listen(port, () => console.log(`dev server on http://localhost:${port}`));
