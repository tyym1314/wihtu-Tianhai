import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),base:'/casino/',cacheDir:'../node_modules/.vite-casino',plugins:[react()],build:{outDir:'dist',emptyOutDir:true,chunkSizeWarningLimit:600}});
