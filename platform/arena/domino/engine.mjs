export const RULE_VERSION='pvp-domino-v1.0.0';
export const TILES=Object.freeze(Array.from({length:7},(_,a)=>Array.from({length:7-a},(_,i)=>Object.freeze({id:`d_${a}_${a+i}`,a,b:a+i}))).flat());
const tileMap=new Map(TILES.map(t=>[t.id,t])),TURN_MS=20000;
const tile=id=>tileMap.get(id);
function fail(code,message=code,status=409){const e=new Error(message);e.code=code;e.status=status;throw e;}
function time(now){if(!Number.isSafeInteger(now)||now<0)fail('INVALID_TIME','Invalid server timestamp',400);}
const eligible=s=>s.players.filter(p=>!p.forfeited);
const pips=p=>p.hand.reduce((n,id)=>n+tile(id).a+tile(id).b,0);
function shuffled(seed){
 const words=Array.from({length:8},(_,i)=>parseInt(seed.slice(i*8,i*8+8),16));let a=0x646f6d69,b=0x6e6f7631,c=0x9e3779b9,d=0x85ebca6b;const mix=x=>{x=Math.imul(x^(x>>>16),0x85ebca6b);x=Math.imul(x^(x>>>13),0xc2b2ae35);return(x^(x>>>16))>>>0;};for(const w of words){a=mix(a^w);b=mix(b+w);c=mix(c^((w<<13)|(w>>>19)));d=mix(d+Math.imul(w,0x9e3779b9));}
 const next=()=>{const t=(a+b+d)>>>0;d=(d+1)>>>0;a=(b^(b>>>9))>>>0;b=(c+(c<<3))>>>0;c=(((c<<21)|(c>>>11))+t)>>>0;return t;};for(let i=0;i<20;i++)next();
 const pick=n=>{const limit=4294967296-4294967296%n;let x;do{x=next();}while(x>=limit);return x%n;};const cards=TILES.map(t=>t.id);for(let i=cards.length-1;i>0;i--){const j=pick(i+1);[cards[i],cards[j]]=[cards[j],cards[i]];}return cards;
}
export function legalMoves(s,key){const p=s.players.find(p=>p.key===key);if(!p||p.forfeited||s.status!=='active')return[];return p.hand.flatMap(id=>{const t=tile(id),ends=[];if(t.a===s.left||t.b===s.left)ends.push('left');if(t.a===s.right||t.b===s.right)ends.push('right');return ends.map(end=>({tileId:id,end}));});}
function finish(s,now,outcome='completed',winnerKey){s.status='finished';s.outcome=outcome;s.finishedAt=now;s.turnKey=null;s.turnDeadlineAt=null;const ps=eligible(s);if(!ps.length){s.outcome='void';s.winnerKeys=[];}else if(winnerKey)s.winnerKeys=[winnerKey];else if(outcome==='forfeit')s.winnerKeys=ps.map(p=>p.key);else{const min=Math.min(...ps.map(pips));s.winnerKeys=ps.filter(p=>pips(p)===min).map(p=>p.key);}}
function eligibility(s,now){if(eligible(s).length<2){finish(s,now,eligible(s).length?'forfeit':'void');return true;}return false;}
function retire(s,p){if(p.forfeited)return;p.forfeited=true;s.removed.push(...p.hand);p.hand=[];s.passStreak=0;}
function next(s,now){for(let i=1;i<=s.players.length;i++){const index=(s.turnIndex+i)%s.players.length;if(!s.players[index].forfeited){s.turnIndex=index;s.turnKey=s.players[index].key;s.turnStartedAt=now;s.turnDeadlineAt=now+TURN_MS;return;}}}
function finishAction(s,now,{defer=false}={}){if(eligible(s).length<2){if(defer)s.deferredEnd=true;else eligibility(s,now);return;}if(s.actionCount>=100||now>=s.deadlineAt){if(defer)s.deferredLimit=true;else finish(s,now,'limit');return;}if(s.passStreak>=eligible(s).length){if(defer)s.deferredLimit=true;else finish(s,now,'blocked');return;}next(s,now);}
function publicEvent(s,event){s.version++;s.lastEvent={id:s.version,...event};return s.lastEvent;}
export function createState(seedHex,now,{players}={}){
 time(now);if(!/^[a-f0-9]{64}$/i.test(seedHex||''))fail('INVALID_SEED','A 256-bit server seed is required',400);
 if(!Array.isArray(players)||![2,4].includes(players.length)||new Set(players.map(p=>p.key)).size!==players.length||players.some(p=>typeof p.key!=='string'||!p.key)||new Set(players.map(p=>p.seatIndex)).size!==players.length)fail('INVALID_PLAYERS','Domino requires 2 or 4 unique players/seats',400);
 const deck=shuffled(seedHex),roster=[...players].sort((a,b)=>a.seatIndex-b.seatIndex).map(p=>({key:p.key,name:p.name||p.key,seatIndex:p.seatIndex,isBot:!!p.isBot,hand:deck.splice(0,7),timeouts:0,forfeited:false,lastPrivateEvent:null}));
 const options=roster.flatMap(p=>p.hand.map(id=>({key:p.key,tile:tile(id)}))),doubles=options.filter(p=>p.tile.a===p.tile.b),opening=(doubles.length?doubles:options).sort((a,b)=>(b.tile.a+b.tile.b)-(a.tile.a+a.tile.b)||b.tile.b-a.tile.b)[0];
 const openingIndex=roster.findIndex(p=>p.key===opening.key);roster[openingIndex].hand=roster[openingIndex].hand.filter(id=>id!==opening.tile.id);
 const s={gameId:'domino',ruleVersion:RULE_VERSION,status:'active',outcome:null,startedAt:now,serverNow:now,deadlineAt:now+300000,players:roster,stock:deck,removed:[],chain:[{tileId:opening.tile.id,left:opening.tile.a,right:opening.tile.b,playedBy:opening.key,at:now}],left:opening.tile.a,right:opening.tile.b,turnIndex:openingIndex,turnKey:opening.key,turnStartedAt:now,turnDeadlineAt:now+TURN_MS,busyUntil:now+500,passStreak:0,actionCount:0,version:1,winnerKeys:[],lastEvent:{id:1,type:'opening',playerKey:opening.key,tileId:opening.tile.id,at:now,end:'right'}};next(s,now+500);return s;
}
function tickInternal(s,now,defer=false){time(now);if(now<s.serverNow)fail('CLOCK_REWIND');s.serverNow=now;if(s.status!=='active')return;for(let i=0;i<120&&s.status==='active'&&now>=s.turnDeadlineAt;i++){
 const at=s.turnDeadlineAt,p=s.players[s.turnIndex];p.timeouts++;s.actionCount++;s.passStreak=0;if(p.timeouts>=3)retire(s,p);publicEvent(s,{type:'timeout',playerKey:p.key,at,forfeited:p.forfeited});finishAction(s,at,{defer});if(s.deferredEnd||s.deferredLimit)break;
 }}
export function tick(s,now){tickInternal(s,now);return{state:s};}
export function act(s,key,action,now){
 if(!action||!['play','draw','pass'].includes(action.type)||Object.keys(action).some(k=>!(['play'].includes(action.type)?['type','tileId','end']:['type']).includes(k)))fail('INVALID_ACTION','Submit only a tile play, draw or legal pass',400);
 tickInternal(s,now);if(s.status!=='active')fail('NOT_ACTIVE');if(s.turnKey!==key)fail('NOT_YOUR_TURN');if(now<s.busyUntil)fail('BUSY');const p=s.players[s.turnIndex],moves=legalMoves(s,key);if(p.forfeited)fail('NOT_A_PLAYER');
 if(action.type==='draw'){
  if(moves.length)fail('MUST_PLAY','You already have a playable tile');if(!s.stock.length)fail('STOCK_EMPTY');const drawn=[];do{const id=s.stock.shift();p.hand.push(id);drawn.push(id);}while(s.stock.length&&!legalMoves(s,key).length);
  p.timeouts=0;const pub=publicEvent(s,{type:'draw',playerKey:key,count:drawn.length,at:now});const event={...pub,drawn:drawn.map(id=>({...tile(id)}))};p.lastPrivateEvent=event;return{state:s,event};
 }
 if(action.type==='pass'){
  if(moves.length||s.stock.length)fail('MUST_PLAY_OR_DRAW','Passing requires no playable hand and an empty stock');p.timeouts=0;s.passStreak++;s.actionCount++;const event=publicEvent(s,{type:'pass',playerKey:key,at:now});finishAction(s,now);return{state:s,event};
 }
 if(!moves.some(m=>m.tileId===action.tileId&&m.end===action.end))fail('ILLEGAL_TILE','The selected tile cannot connect to this end',400);
 const t=tile(action.tileId),match=action.end==='left'?s.left:s.right,other=t.a===match?t.b:t.a;
 const placed={tileId:t.id,left:action.end==='left'?other:match,right:action.end==='right'?other:match,playedBy:key,at:now};if(action.end==='left'){s.chain.unshift(placed);s.left=other;}else{s.chain.push(placed);s.right=other;}
 p.hand=p.hand.filter(id=>id!==t.id);p.timeouts=0;s.passStreak=0;s.actionCount++;s.busyUntil=now+420;const event=publicEvent(s,{type:'play',playerKey:key,tileId:t.id,end:action.end,left:s.left,right:s.right,at:now,busyUntil:s.busyUntil});
 if(!p.hand.length)finish(s,now,'empty_hand',key);else finishAction(s,now+420);return{state:s,event};
}
export function forfeit(s,keys,now){time(now);if(s.status!=='active')return{state:s};if(!Array.isArray(keys)||keys.some(k=>!s.players.some(p=>p.key===k)))fail('INVALID_PLAYER');tickInternal(s,now,true);if(s.status!=='active')return{state:s};const turnKey=s.turnKey;for(const p of s.players)if(keys.includes(p.key))retire(s,p);s.passStreak=0;
 if(!eligibility(s,now)){if(s.deferredLimit)finish(s,now,'limit');else if(s.players.find(p=>p.key===turnKey)?.forfeited||s.deferredEnd)next(s,now);}
 delete s.deferredEnd;delete s.deferredLimit;const event=publicEvent(s,{type:'forfeit',playerKeys:keys,at:now});return{state:s,event};
}
export function shiftTime(s,ms){if(!Number.isSafeInteger(ms)||ms<0)fail('INVALID_PAUSE','Invalid pause',400);for(const k of ['startedAt','serverNow','deadlineAt','turnStartedAt','turnDeadlineAt','busyUntil'])if(typeof s[k]==='number')s[k]+=ms;return s;}
export function rank(s){const ps=eligible(s);return s.players.map(p=>({playerKey:p.key,rank:p.forfeited?null:s.status!=='finished'?null:s.winnerKeys.includes(p.key)?1:2+ps.filter(q=>!s.winnerKeys.includes(q.key)&&pips(q)<pips(p)).length,score:s.status==='finished'?pips(p):0,forfeited:p.forfeited}));}
export function view(s,key){const me=s.players.find(p=>p.key===key);if(!me)fail('NOT_A_PLAYER','Not in room',403);const moves=legalMoves(s,key);return{gameId:'domino',status:s.status,outcome:s.outcome,ruleVersion:s.ruleVersion,serverNow:s.serverNow,deadlineAt:s.deadlineAt,turnKey:s.turnKey,turnDeadlineAt:s.turnDeadlineAt,busyUntil:s.busyUntil,actionCount:s.actionCount,passStreak:s.passStreak,left:s.left,right:s.right,chain:s.chain.map(p=>({...p})),stockCount:s.stock.length,hand:me.hand.map(id=>({...tile(id)})),legalMoves:moves,canDraw:s.status==='active'&&s.turnKey===key&&!moves.length&&s.stock.length>0,canPass:s.status==='active'&&s.turnKey===key&&!moves.length&&!s.stock.length,players:s.players.map(p=>({key:p.key,name:p.name,seatIndex:p.seatIndex,isBot:p.isBot,handCount:p.hand.length,forfeited:p.forfeited,timeouts:p.timeouts,...(s.status==='finished'?{pips:pips(p)}:{})})),lastEvent:structuredClone(me.lastPrivateEvent?.id===s.lastEvent?.id?me.lastPrivateEvent:s.lastEvent),version:s.version,winnerKeys:[...s.winnerKeys]};}
export function botAction(s,key,now){if(s.status!=='active'||s.turnKey!==key||now<s.busyUntil)return null;const p=s.players.find(p=>p.key===key);if(!p||p.forfeited)return null;const moves=legalMoves(s,key).sort((a,b)=>(tile(b.tileId).a+tile(b.tileId).b)-(tile(a.tileId).a+tile(a.tileId).b));return moves[0]?{type:'play',...moves[0]}:s.stock.length?{type:'draw'}:{type:'pass'};}
