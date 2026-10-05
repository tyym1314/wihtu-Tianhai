import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('../../',import.meta.url)),cacheDir:'node_modules/.vite-golf-review',plugins:[react()],optimizeDeps:{entries:['arena/golf/preview.html']},server:{host:'127.0.0.1',port:18096,strictPort:true}});
