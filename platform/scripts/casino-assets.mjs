// Convert generated casino art (platform/.local/art/<game>/*.png) into compact WebP game assets
// under casino/public/<game>/. Sizes are per asset role. Usage: node scripts/casino-assets.mjs <game> [name:width ...]
import {execFileSync} from 'node:child_process';
import {mkdirSync,readdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const [game,...overrides]=process.argv.slice(2);
if(!game)throw new Error('usage: casino-assets.mjs <game> [name:width ...]');
const src=`${root}.local/art/${game}`,out=`${root}casino/public/${game}`;
mkdirSync(out,{recursive:true});
const widths={background:1080,lion:640,ring:960,mascot:640,logo:720};
for(const o of overrides){const [k,v]=o.split(':');widths[k]=Number(v);}
for(const file of readdirSync(src).filter(f=>f.endsWith('.png'))){
 const name=file.slice(0,-4),width=widths[name]||256,target=`${out}/${name}.webp`;
 execFileSync('cwebp',['-quiet','-q',name==='background'?'78':'84','-alpha_q','90','-resize',String(width),'0',`${src}/${file}`,'-o',target]);
 console.log(name,width,existsSync(target));
}
