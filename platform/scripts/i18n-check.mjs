/** Fails if any t() call in the i18n files resolves to something other than the i18n import. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import {I18N_FILES} from './i18n-codemod.mjs';
const traverse=traverseModule.default||traverseModule;
const root=resolve(import.meta.dirname,'..');
let bad=0;
for(const file of I18N_FILES){
 const source=readFileSync(resolve(root,file),'utf8');if(!/i18n\.mjs'/.test(source))continue;
 const ast=parse(source,{sourceType:'module',plugins:['jsx']});
 traverse(ast,{CallExpression(path){
  const c=path.node.callee;if(c.type!=='Identifier'||c.name!=='$t')return;
  const a=path.node.arguments[0];if(!a||!(a.type==='StringLiteral'&&/[\u3400-\u9fff]/.test(a.value)))return;
  const binding=path.scope.getBinding('$t');
  if(!binding||binding.kind!=='module'){bad++;console.log(`${file}:${path.node.loc.start.line} t shadowed by ${binding?.kind||'none'} (${binding?.path.node.type})`);}
 }});
}
if(bad){console.error(`${bad} shadowed t() calls`);process.exit(1);}else console.log('i18n t() bindings ok');
