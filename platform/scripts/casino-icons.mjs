// Plate + per-item icons for wheel-family games, cropped from .local/art/<game>-plate/plate.png using
// casino/games/wheel/layouts.mjs. Usage: node scripts/casino-icons.mjs <game...>
import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {LAYOUTS} from '../casino/games/wheel/layouts.mjs';
const root=new URL('..',import.meta.url).pathname;
for(const game of process.argv.slice(2)){
 const src=`${root}.local/art/${game}-plate/plate.png`,out=`${root}casino/public/${game}`,tmp=`/tmp/icons-${game}`;mkdirSync(out,{recursive:true});mkdirSync(tmp,{recursive:true});
 execFileSync('cwebp',['-quiet','-q','82',src,'-o',`${out}/plate.webp`]);
 for(const [id,[x,y,a,b]] of Object.entries(LAYOUTS[game].items)){
  // Round plates: the inner 78% of the circle; cards/tiles: the picture area above the multiplier label.
  const [w,h,cx,cy]=b===undefined?[Math.round(a*1.56),Math.round(a*1.56),x,y-Math.round(a*.12)]:[Math.round(a*.86),Math.round(b*.66),x,y-Math.round(b*.12)];
  execFileSync('sips',['-c',String(h),String(w),'--cropOffset',String(cy-Math.round(h/2)),String(cx-Math.round(w/2)),src,'--out',`${tmp}/${id}.png`],{stdio:'ignore'});
  execFileSync('cwebp',['-quiet','-q','86','-resize','140','0',`${tmp}/${id}.png`,'-o',`${out}/icon-${id}.webp`]);
 }
 console.log(game,'ok');
}
