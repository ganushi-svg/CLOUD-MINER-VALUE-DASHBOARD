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
      const { default: handler } = await import(new URL(`api/${name}.js`, root));
      const shim = {
        status(code) { res.statusCode = code; return shim; },
        json(body) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body, null, 2)); return shim; },
      };
      return handler({ method: req.method, query: Object.fromEntries(url.searchParams) }, shim);
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
