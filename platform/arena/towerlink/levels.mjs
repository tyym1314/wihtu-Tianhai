import {createBoard as createLegacyBoard,createTrainingBoard} from './levels-v2.1.mjs';
export {createTrainingBoard};
export const LEVEL_VERSION='towerlink-maps-v2.2.0';
export const LEVELS=Object.freeze([
 {id:'duel-central-gates',name:'双向桥头',subtitle:'夺取中枢 · 保卫补给',playerCount:2,variant:0,topology:'bridgehead'},
 {id:'duel-ring-flank-v2',name:'环形包抄',subtitle:'外围迂回 · 切断增援',playerCount:2,variant:1,topology:'flank'},
 {id:'trio-supply-web',name:'三向补给网',subtitle:'双环调度 · 多线增援',playerCount:3,variant:0,topology:'supply-web'},
 {id:'trio-central-gates',name:'三方桥头',subtitle:'守住中枢 · 逐段推进',playerCount:3,variant:1,topology:'bridgehead'},
 {id:'quad-supply-web',name:'四方补给网',subtitle:'多路抢中 · 内外呼应',playerCount:4,variant:0,topology:'supply-web'},
 {id:'quad-island-flank',name:'环岛侧击',subtitle:'外环包抄 · 侧翼争夺',playerCount:4,variant:1,topology:'flank'},
].map(level=>Object.freeze({...level,contentVersion:LEVEL_VERSION})));
/** Public authored graph families. Every seat rotation preserves road weights. */
export function createBoard(playerCount,levelIndex=0){
 const level=LEVELS.find(l=>l.playerCount===playerCount&&l.variant===levelIndex);
 if(!level||!Number.isInteger(levelIndex))throw new RangeError('Invalid Tower Link map');
 const map=createLegacyBoard(playerCount,level.topology==='flank'?1:0);
 if(level.topology==='bridgehead'){
  // Only the citadel joins radial approaches: a real inter-sector supply choke.
  const outer=map.board.outerCount;
  map.edges=map.edges.filter(([a,b])=>(a<outer&&b>=outer)||b===12);
  const keys=new Set(map.edges.map(([a,b])=>`${a}:${b}`));
  map.roads=map.roads.filter(r=>keys.has(r.id));
  for(const t of map.towers)t.neighbors=[];
  for(const[a,b]of map.edges){map.towers[a].neighbors.push(b);map.towers[b].neighbors.push(a);}
  for(const t of map.towers)t.neighbors.sort((a,b)=>a-b);
 }
 return{...map,level:{...level},board:{...map.board,topology:level.topology,contentVersion:LEVEL_VERSION}};
}
