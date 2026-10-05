import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
function fontLicenses(){return{name:'local-font-licenses',generateBundle(){
 const base=new URL('../shared/fonts/',import.meta.url),manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8'));
 const fonts=manifest.fonts.filter(font=>['dm-sans','cormorant-garamond'].includes(font.id));
 for(const font of fonts)this.emitFile({type:'asset',fileName:'font-licenses/'+font.license_file,source:readFileSync(new URL(font.license_file,base),'utf8')});
 this.emitFile({type:'asset',fileName:'font-licenses/manifest.json',source:JSON.stringify({...manifest,fonts},null,2)+'\n'});
}};}
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),base:'/arena/',cacheDir:'../node_modules/.vite-arena',plugins:[react(),fontLicenses()],build:{outDir:'dist',emptyOutDir:true,chunkSizeWarningLimit:900,rollupOptions:{output:{manualChunks:{three:['three']}}}}});
