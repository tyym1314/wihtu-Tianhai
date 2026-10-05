import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createTigerHandler } from './tiger.js';

const port = Number(process.env.TIGER_PORT || 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid TIGER_PORT');
const root = resolve(process.env.TIGER_STATIC_DIR || 'dist-tiger');
const handler = await createTigerHandler({ storePath: resolve(process.env.TIGER_DATA_PATH || '.data/tiger-sessions.json') });
const mime: Record<string, string> = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml', '.json':'application/json', '.wav':'audio/wav', '.woff2':'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    if (await handler(req,res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    const file = resolve(root, `.${pathname === '/' ? '/tiger.html' : pathname}`);
    if (!file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    if (!(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'content-length':content.length, 'cache-control':extname(file)==='.html'?'no-store':'public, max-age=3600', 'x-content-type-options':'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { if (!res.headersSent) res.writeHead(404); res.end('Not found'); }
});
server.listen(port,process.env.TIGER_HOST || '127.0.0.1',()=>console.log(`Golden Tiger: http://127.0.0.1:${port}/ — independent demo wallet`));
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>server.close(()=>process.exit(0)));
