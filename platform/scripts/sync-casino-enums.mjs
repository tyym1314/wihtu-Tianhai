// Add every casino game definition to the OpenAPI GameId / ProbabilityGameId enums (wallet contract).
import {readFileSync,writeFileSync} from 'node:fs';
import {ALL_CASINO_DEFINITIONS} from '../shared/casino-games.mjs';
const file=new URL('../specs/openapi.json',import.meta.url),spec=JSON.parse(readFileSync(file,'utf8'));
let added=0;for(const k of ['GameId','ProbabilityGameId']){const e=spec.components.schemas[k].enum;for(const id of ALL_CASINO_DEFINITIONS)if(!e.includes(id)){e.push(id);added++;}}
writeFileSync(file,JSON.stringify(spec,null,2));console.log('added',added);
