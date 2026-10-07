// Local development server: `npm run dev`, then open http://localhost:3000
// Serves public/ and runs api/game.js the way Vercel does. With no Redis
// variables set it uses an in-memory store; set REDIS_URL (or the Upstash
// KV_REST_API_URL + KV_REST_API_TOKEN pair) to test against a real database.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/game.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/api/game') {
    // Minimal versions of the helpers Vercel adds to Node functions.
    req.query = Object.fromEntries(url.searchParams);
    if (req.method === 'POST') {
      let data = '';
      for await (const c of req) data += c;
      try { req.body = JSON.parse(data || '{}'); } catch { req.body = {}; }
    }
    res.status = code => { res.statusCode = code; return res; };
    res.json = obj => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
    return handler(req, res);
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
  try {
    const body = await fs.readFile(file);
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404; res.end('Not found');
  }
}).listen(PORT, () => console.log(`Hex Blueprints running at http://localhost:${PORT}`));
