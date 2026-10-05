import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({plugins:[react()],root:fileURLToPath(new URL('.',import.meta.url)),cacheDir:fileURLToPath(new URL('../../node_modules/.vite-carrom-review',import.meta.url)),server:{host:'127.0.0.1',port:18107,strictPort:true,fs:{allow:[fileURLToPath(new URL('../../../',import.meta.url))]}}});
