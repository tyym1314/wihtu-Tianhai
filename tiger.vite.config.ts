import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  server: { host: '127.0.0.1', port: 5174, strictPort: true, proxy: { '/api/tiger': 'http://127.0.0.1:8790' } },
  build: { outDir: 'dist-tiger', target: 'es2022', rollupOptions: { input: resolve('tiger.html') } },
});
