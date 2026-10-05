import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('../',import.meta.url)),base:'/arena/',cacheDir:fileURLToPath(new URL('../../node_modules/.vite-golf-bowling-art',import.meta.url)),server:{host:'127.0.0.1',port:18122,strictPort:true,watch:{ignored:['**/assets/**']},fs:{allow:[fileURLToPath(new URL('../../../',import.meta.url))]}}});
