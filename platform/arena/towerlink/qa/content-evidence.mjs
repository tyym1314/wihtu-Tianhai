import * as game from '../engine.mjs';
import {createBoard,LEVELS} from '../levels.mjs';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
export function findSeed(level){for(let i=0;i<100;i++){const seed=i.toString(16).padStart(32,'0');if(game.createState(seed,1000,{players:Array.from({length:level.playerCount},(_,i)=>'p'+i)}).level.id===level.id)return seed;}throw Error('Unreachable map');}
export function graphMetrics(map){
 const components=(omit=null)=>{const left=new Set(map.towers.map(t=>t.id).filter(i=>i!==omit)),sizes=[];while(left.size){const q=[left.values().next().value];left.delete(q[0]);for(const id of q)for(const n of map.towers[id].neighbors)if(left.delete(n))q.push(n);sizes.push(q.length);}return sizes.sort((a,b)=>a-b);};
 return{id:map.level.id,topology:map.level.topology,edges:map.edges.length,cycleRank:map.edges.length-map.towers.length+1,components:components(),withoutCore:components(12),innerEdges:map.edges.filter(([a,b])=>a>=map.board.outerCount&&b<12).length,leafCount:map.towers.filter(t=>t.neighbors.length===1).length};
}
export function playMap(level,{idle=false,centralRush=false}={}){
 const seed=findSeed(level),state=game.createState(seed,1000,{players:Array.from({length:level.playerCount},(_,i)=>({key:'p'+i,isBot:true}))}),actions=[],events=new Map();
 for(let now=1000;state.status==='active'&&now<=state.deadlineAt;now+=250){
  game.tick(state,now);
  if(!idle)for(const key of Object.keys(state.players)){let action;if(centralRush&&key==='p0'&&state.owners[12]!=='p0'){const legal=game.view(state,key).legalActions;action=legal.find(a=>a.type==='upgrade'&&state.towers[a.towerId].level===1)||legal.find(a=>a.type==='link'&&(a.to===12||(a.from<state.board.outerCount&&a.to>=state.board.outerCount)));}else action=game.botAction(state,key,now);if(action){game.act(state,key,action,now);actions.push({now,key,action});}}
  for(const event of state.events)events.set(event.id,event);
 }
 return{level:level.id,seed,idle,centralRush,centralCapturedAt:[...events.values()].find(e=>e.type==='capture'&&e.towerId===12&&e.ownerKey==='p0')?.at??null,status:state.status,finishReason:state.finishReason,finishedAt:state.finishedAt,ranks:game.rank(state),captures:[...events.values()].filter(e=>e.type==='capture').length,upgrades:actions.filter(e=>e.action.type==='upgrade').length,actions,final:state};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const result={at:new Date().toISOString(),ruleVersion:game.RULE_VERSION,scope:'Deterministic authority-engine replay, no browser timing or human balance claim',maps:LEVELS.map(l=>graphMetrics(createBoard(l.playerCount,l.variant))),breakthroughs:LEVELS.filter(l=>l.topology==='bridgehead').map(l=>{const r=playMap(l,{centralRush:true});delete r.final;return r;}),games:LEVELS.map(l=>{const r=playMap(l);delete r.final;return r;})};
 await writeFile(new URL('./content-20260928/engine-traces.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result.games.map(({actions,...r})=>({...r,acceptedActions:actions.length})),null,2));
}
