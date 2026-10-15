/**
 * Arena UI i18n codemod. Wraps Chinese UI text with t() from arena/shared/i18n.mjs.
 *   node scripts/i18n-codemod.mjs --list      -> print unique source strings (JSON)
 *   node scripts/i18n-codemod.mjs --write     -> rewrite files in place
 * Only exact source positions are spliced, so the original formatting is preserved.
 * Comparisons, object keys, imports and existing t() calls are left untouched.
 */
import {readFileSync,writeFileSync} from 'node:fs';
import {relative,dirname,resolve} from 'node:path';
import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
const traverse=traverseModule.default||traverseModule;
const root=resolve(import.meta.dirname,'..');
export const I18N_FILES=['arena/main.jsx','arena/shared/ThemeResult.jsx','arena/boardkit/ui.jsx','arena/match/MatchGame.jsx','arena/golf/GolfGame.jsx',
 'arena/bowling/BowlingGame.jsx','arena/carrom/CarromGame.jsx','arena/pool/PoolGame.jsx','arena/darts/DartsGame.jsx','arena/ludo/LudoGame.jsx',
 'arena/jackaroo/JackarooGame.jsx','arena/domino/DominoGame.jsx','arena/towerlink/TowerLinkGame.jsx','arena/run/PracticeCourses.jsx','arena/run/RunPodium.jsx',
 'arena/golf/content.mjs','arena/match/objectives.mjs','arena/towerlink/training.mjs'];
const CJK=/[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;
const esc=s=>JSON.stringify(s);
function skip(path){
 const p=path.parentPath;if(!p)return false;
 if(p.isImportDeclaration()||p.isExportAllDeclaration()||p.isExportNamedDeclaration())return true;
 if((p.isObjectProperty()||p.isObjectMethod()||p.isClassProperty())&&p.node.key===path.node&&!p.node.computed)return true;
 if(p.isBinaryExpression()&&['===','!==','==','!='].includes(p.node.operator))return true;
 if(p.isSwitchCase())return true;
 if(p.isMemberExpression()&&p.node.property===path.node)return true;
 if(p.isCallExpression()&&p.node.callee.type==='Identifier'&&['t','$t'].includes(p.node.callee.name))return true;
 if(p.isCallExpression()&&p.node.callee.type==='MemberExpression'&&['includes','startsWith','endsWith','indexOf','test','get','has','error','warn','log'].includes(p.node.callee.property?.name))return true;
 if(p.isJSXAttribute()&&['className','key','id','data-testid','src','href'].includes(p.node.name.name))return true;
 return false;
}
export function transform(file,source){
 const ast=parse(source,{sourceType:'module',plugins:['jsx']});const edits=[],keys=[];
 traverse(ast,{
  StringLiteral(path){
   const v=path.node.value;if(!CJK.test(v)||skip(path))return;
   keys.push(v);const p=path.parentPath,call=`$t(${esc(v)})`;
   edits.push([path.node.start,path.node.end,p.isJSXAttribute()?`{${call}}`:call]);
  },
  JSXText(path){
   const raw=path.node.value;if(!CJK.test(raw))return;
   const text=raw.trim();const lead=raw.slice(0,raw.indexOf(text)),tail=raw.slice(raw.indexOf(text)+text.length);
   keys.push(text);edits.push([path.node.start,path.node.end,`${lead}{$t(${esc(text)})}${tail}`]);
  },
  TemplateLiteral(path){
   if(path.parentPath.isTaggedTemplateExpression())return;
   const q=path.node.quasis;if(!q.some(x=>CJK.test(x.value.cooked??x.value.raw))||skip(path))return;
   let template='';q.forEach((x,i)=>{template+=(x.value.cooked??x.value.raw).replace(/[{}]/g,m=>m+m);if(i<path.node.expressions.length)template+=`{${i}}`;});
   keys.push(template);
   const exprs=path.node.expressions.map(e=>source.slice(e.start,e.end));
   edits.push([path.node.start,path.node.end,`$t(${esc(template)}${exprs.length?`,[${exprs.join(',')}]`:''})`]);
   path.skip();
  },
 });
 edits.sort((a,b)=>b[0]-a[0]);
 let out=source;for(const [s,e,r] of edits)out=out.slice(0,s)+r+out.slice(e);
 if(edits.length&&!/i18n\.mjs'/.test(out)){
  let rel=relative(dirname(resolve(root,file)),resolve(root,'arena/shared/i18n.mjs'));if(!rel.startsWith('.'))rel='./'+rel;
  out=`import {t as $t} from '${rel}';\n`+out;
 }
 return {out,keys,count:edits.length};
}
if(import.meta.url===`file://${process.argv[1]}`){
 const all=new Map();let total=0;
 for(const file of I18N_FILES){const src=readFileSync(resolve(root,file),'utf8');const r=transform(file,src);total+=r.count;for(const k of r.keys)if(!all.has(k))all.set(k,file);if(process.argv.includes('--write')&&r.count)writeFileSync(resolve(root,file),r.out);}
 const {ARENA_GAMES}=await import('../shared/games.mjs');
 for(const g of Object.values(ARENA_GAMES))for(const v of [g.name,g.description,g.scoreUnit,...(g.rules||[])])if(typeof v==='string'&&CJK.test(v)&&!all.has(v))all.set(v,'shared/games.mjs');
 if(process.argv.includes('--list'))console.log(JSON.stringify([...all.keys()],null,1));
 console.error(`edits=${total} unique=${all.size}`);
}
