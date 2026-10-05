import test from 'node:test';
import assert from 'node:assert/strict';
import {supportsRules} from '../server/pvp/rule-support.mjs';
test('historical rules require an explicit true whitelist, current rules remain compatible',()=>{
 const current={RULE_VERSION:'v2'},legacy={...current,supportsRuleVersion:v=>v==='v1'};
 assert(supportsRules(current,'v2'));assert(!supportsRules(current,'v1'));assert(supportsRules(legacy,'v1'));
 for(const version of[undefined,null,'v0','v3'])assert(!supportsRules(legacy,version));
 assert(!supportsRules(null,'v2'));assert(!supportsRules({...current,supportsRuleVersion:()=>1},'v1'));
});
