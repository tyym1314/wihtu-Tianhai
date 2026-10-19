import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import DICTIONARY from '../arena/shared/i18n-dict.mjs';
import {t,setLocale} from '../arena/shared/i18n.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
test('every translated arena string resolves to the i18n import (no shadowed $t)',()=>{
 assert.match(execFileSync(process.execPath,['scripts/i18n-check.mjs'],{cwd:root,encoding:'utf8'}),/bindings ok/);
});
test('every wrapped source string has English and Arabic, with matching placeholders',()=>{
 const keys=JSON.parse(execFileSync(process.execPath,['scripts/i18n-codemod.mjs','--list'],{cwd:root,encoding:'utf8'}));
 for(const k of keys){const entry=DICTIONARY[k];assert.ok(entry&&entry[0]&&entry[1],'missing translation: '+k);
  for(const n of (k.match(/\{\d\}/g)||[]))assert.ok(entry[0].includes(n)&&entry[1].includes(n),'placeholder '+n+' in '+k);}
});
test('t() formats placeholders and falls back to the source text',()=>{
 setLocale('en',{persist:false});
 assert.equal(t('已就位 {0} / {1} 名玩家',[1,2]),'1 / 2 players ready');
 assert.equal(t('未登记的中文'),'未登记的中文');
 // Players never get Chinese: a zh request resolves to English.
 setLocale('zh',{persist:false});
 assert.equal(t('已就位 {0} / {1} 名玩家',[1,2]),'1 / 2 players ready');
});
