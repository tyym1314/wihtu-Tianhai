// Loading-screen data for /launch/: per game name (zh/en/ar), tip family, theme color and icon.
// Icons come from .local/art/icons/<id>.png (scripts: .local/art/icons/gen.mjs); run after adding art.
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {CASINO_GAMES,CASINO_IDS} from '../shared/casino-games.mjs';
import {ARENA_GAMES,ARENA_IDS} from '../shared/games.mjs';
import DICT from '../arena/shared/i18n-dict.mjs';
const out='public/launch',icons=`${out}/icons`;mkdirSync(icons,{recursive:true});
const meta={};
for(const id of CASINO_IDS){const g=CASINO_GAMES[id];meta[id]={name:{zh:g.zh,en:g.name,ar:g.ar},family:g.family,...(g.orientation?{orientation:g.orientation}:{})};}
for(const id of ARENA_IDS){const g=ARENA_GAMES[id],d=DICT[g.name]||[];meta[id]={name:{zh:g.name,en:d[0]||g.en,ar:d[1]||d[0]||g.en},family:'arena'};}
meta.thunder={name:{zh:'雷霆王座',en:'Thunder Throne',ar:'عرش الرعد'},family:'slot'};
meta.tiger={name:{zh:'虎虎生财',en:'Golden Tiger',ar:'النمر الذهبي'},family:'slot'};
for(const [id,m] of Object.entries(meta)){
 const src=`.local/art/icons/${id}.png`;if(!existsSync(src)){console.warn('no icon',id);continue;}
 execFileSync('cwebp',['-quiet','-q','82','-resize','512','512',src,'-o',`${icons}/${id}.webp`]);
 // Theme color: the icon's average color, darkened for the background.
 const rgb=execFileSync('ffmpeg',['-loglevel','error','-i',src,'-vf','scale=1:1','-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:64});
 m.color=[...rgb].map(v=>Math.round(v));m.icon=true;
}
writeFileSync(`${out}/meta.json`,JSON.stringify(meta));
// Inline the same data into the launch page (first frame without waiting for meta.json).
{const page=`${out}/index.html`,html=readFileSync(page,'utf8'),next=html.replace(/\/\*LAUNCH_META\*\/[\s\S]*?\/\*END_LAUNCH_META\*\//,`/*LAUNCH_META*/${JSON.stringify(meta)}/*END_LAUNCH_META*/`);
 if(next===html&&!html.includes('/*LAUNCH_META*/'))throw new Error('launch page has no LAUNCH_META marker');writeFileSync(page,next);}
console.log(Object.keys(meta).length,'games,',Object.values(meta).filter(m=>m.icon).length,'with icons');
