import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
function specs() {
  return {
    name: 'design-specifications',
    configureServer(server) {
      server.middlewares.use('/specs', (req, res, next) => {
        let name;
        try { name = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.statusCode=400; res.end(); return; }
        const target = path.resolve(root, 'specs', `.${name}`);
        if (!target.startsWith(path.join(root, 'specs') + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return next();
        res.setHeader('Content-Type', target.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
        fs.createReadStream(target).pipe(res);
      });
    },
    closeBundle() { if (fs.existsSync(path.join(root, 'specs'))) fs.cpSync(path.join(root, 'specs'), path.join(root, 'dist/specs'), { recursive: true }); }
  };
}
export default defineConfig({ plugins: [react(), specs()], server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**', '**/server/**', '**/tests/**', '**/scripts/**'] }, host: '127.0.0.1', port: 8795, strictPort: true, proxy: { '/arena': 'http://127.0.0.1:8797', '/api': 'http://127.0.0.1:8797', '/v1': 'http://127.0.0.1:8797', '/play': 'http://127.0.0.1:8797', '/legacy': 'http://127.0.0.1:8797' } }, build: { chunkSizeWarningLimit: 650 } });
