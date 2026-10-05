/** Current rules by default; historical versions only by an explicit engine contract. */
export function supportsRules(engine,version){
 return !!engine&&typeof version==='string'&&(version===engine.RULE_VERSION||typeof engine.supportsRuleVersion==='function'&&engine.supportsRuleVersion(version)===true);
}
