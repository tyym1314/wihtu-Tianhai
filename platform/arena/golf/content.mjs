import {t as $t} from '../shared/i18n.mjs';
import {LEVELS as BASE_LEVELS} from './levels-v1.mjs';

export const CONTENT_VERSION='oasis-golf-nine-holes-v1';
export const CONTENT_LEVEL_VERSION='oasis-golf-islands-v2';
// Preserve the authored masonry exactly. Tees and bumpers are rendered from
// these same coordinates, while cup/curbs/open water edges stay on their GLB.
const definitions=[
 {id:'palm-golden-putt',artIndex:0,difficulty:'easy',name:$t("金杯短推"),nameEn:'GOLDEN PUTT',par:2,tee:[.65,-.45],bumpers:[[.84,.65,.32]],strategy:$t("从左侧开球，控制短推落点，避开右侧护杯柱。")},
 {id:'moon-last-bend',artIndex:1,difficulty:'easy',name:$t("月泉末弯"),nameEn:'LAST MOON BEND',par:2,tee:[.70,.50],bumpers:[[.84,-.60,.32]],strategy:$t("在最后弯道开球，从护杯柱右侧绕入。")},
 {id:'royal-approach',artIndex:2,difficulty:'easy',name:$t("王冠切入"),nameEn:'ROYAL APPROACH',par:2,tee:[.66,-.55],bumpers:[[.84,.55,.34]],strategy:$t("从左侧短弯切入，力度过大会越过杯口。")},
 {id:'palm-switchback',artIndex:0,difficulty:'medium',name:$t("棕榈折线"),nameEn:'PALM SWITCHBACK',par:3,tee:[.25,.65],bumpers:[[.46,0,.36],[.72,-.55,.38]],strategy:$t("先绕开中央柱，再向对侧调整护杯柱后的进攻线。")},
 {id:'moon-water-guard',artIndex:1,difficulty:'medium',name:$t("月泉护岸"),nameEn:'MOONWATER GUARD',par:3,tee:[.18,-.55],bumpers:[[.40,-.60,.38],[.72,.50,.37]],strategy:$t("通过岸边缺口时保守分段，再绕右侧终段柱。")},
 {id:'royal-double-turn',artIndex:2,difficulty:'medium',name:$t("王冠双折"),nameEn:'ROYAL DOUBLE TURN',par:3,tee:[.22,.55],bumpers:[[.40,.45,.38],[.65,-.45,.38]],strategy:$t("两次交替绕柱，利用弯道中间落点改变下一杆方向。")},
 {id:'palm-slalom',artIndex:0,difficulty:'hard',name:$t("棕榈回旋"),nameEn:'PALM SLALOM',par:5,tee:[.02,-.70],bumpers:[[.23,-.35,.44],[.46,.40,.44],[.70,-.40,.43],[.89,.48,.34]],strategy:$t("从全长起点依次交替绕过四柱，最后减力攻杯。")},
 {id:'moon-coast-route',artIndex:1,difficulty:'hard',name:$t("月泉险岸"),nameEn:'MOON COAST ROUTE',par:5,tee:[.01,.65],bumpers:[[.24,.25,.42],[.46,-.30,.42],[.64,.35,.44],[.85,-.50,.38]],strategy:$t("四柱与侧岸缺口共同限制线路，需要分段留在实心护栏内侧。")},
 {id:'royal-four-gates',artIndex:2,difficulty:'hard',name:$t("王冠四门"),nameEn:'ROYAL FOUR GATES',par:5,tee:[0,-.70],bumpers:[[.23,-.40,.40],[.43,.35,.43],[.64,-.25,.42],[.84,.45,.36]],strategy:$t("从长弯开球，交替通过四个窄门，避免右侧水口。")},
];
function at(base,progress,offset){const p=base.samples[Math.round(progress*(base.samples.length-1))];return{x:Number((p.x+p.nx*offset).toFixed(9)),z:Number((p.z+p.nz*offset).toFixed(9))};}
export const GOLF_HOLES=Object.freeze(definitions.map(def=>{const base=BASE_LEVELS[def.artIndex];return Object.freeze({...base,id:def.id,name:def.name,nameEn:def.nameEn,par:def.par,artIndex:def.artIndex,difficulty:def.difficulty,strategy:def.strategy,version:CONTENT_LEVEL_VERSION,contentVersion:CONTENT_VERSION,tee:Object.freeze(at(base,...def.tee)),bumpers:Object.freeze(def.bumpers.map(([p,o,r])=>Object.freeze({...at(base,p,o),r}))),baseId:base.id});}));
export function golfHole(id){const hole=GOLF_HOLES.find(level=>level.id===id);if(!hole)throw Object.assign(new Error('Unknown pinned golf hole'),{code:'PINNED_CONTENT_UNAVAILABLE',status:409});return hole;}
export function selectGolfHoles(seedHex){
 const order=[0,1,2];let offset=0;for(let i=2;i>0;i--){const j=parseInt(seedHex.slice(offset,offset+8),16)%(i+1);[order[i],order[j]]=[order[j],order[i]];offset+=8;}
 return ['easy','medium','hard'].map((difficulty,index)=>GOLF_HOLES.find(hole=>hole.artIndex===order[index]&&hole.difficulty===difficulty).id);
}
export function roundGolfHole(game,index=game?.holeIndex??0){
 if(game?.ruleVersion==='pvp-golf-v1.1.0'){
  if(game.contentVersion!==CONTENT_VERSION||game.levelVersion!==CONTENT_LEVEL_VERSION||!Array.isArray(game.holeIds)||game.holeIds.length!==3||new Set(game.holeIds).size!==3||!Number.isInteger(index)||index<0||index>2)throw Object.assign(new Error('Unavailable pinned golf content'),{code:'PINNED_CONTENT_UNAVAILABLE',status:409});
  const holes=game.holeIds.map(golfHole);if(new Set(holes.map(h=>h.artIndex)).size!==3||holes.some((h,i)=>h.difficulty!==['easy','medium','hard'][i]))throw Object.assign(new Error('Invalid pinned golf round'),{code:'PINNED_CONTENT_UNAVAILABLE',status:409});
  return golfHole(game.holeIds[index]);
 }
 if(!Number.isInteger(index)||!BASE_LEVELS[index])throw new RangeError('Invalid golf hole');return BASE_LEVELS[index];
}
