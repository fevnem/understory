// serve.mjs — a dependency-free static server for previewing Understory over the LAN/public IP.
// Why not `python3 -m http.server`: it sends `Last-Modified` and lets the browser cache scripts, so
// a page can end up running an OLD main.js against NEW index.html — the buttons render but nothing
// is wired to them and no error is logged. This sends `no-store` so a reload always matches.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.argv[2] || process.cwd();
const PORT = Number(process.argv[3] || 8152);
const HOST = process.argv[4] || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const info = await stat(file);
    if (info.isDirectory()) { res.writeHead(302, { location: rel + '/' }).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
      'content-length': body.length
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('not found');
  }
}).listen(PORT, HOST, () => console.log('serving ' + ROOT + ' on http://' + HOST + ':' + PORT));
