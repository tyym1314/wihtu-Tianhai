/**
 * Three-hand Teen Patti betting: one 52-card deck, three hands of three cards, players bet on
 * which hand wins. Every hand wins with probability 1/3 (symmetric deal); the winning bet pays
 * stake x payout_x100/100 (stake included). Cards are distinct, so the ordering is always strict.
 * Ranking: trail > pure sequence > sequence > color > pair > high card; ties break by points,
 * then by the suit of the highest card (spades > hearts > clubs > diamonds).
 */
import {createHash} from 'node:crypto';
import {createRng} from './rng.mjs';

const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
export const SUITS=['d','c','h','s'];            // ascending: diamonds < clubs < hearts < spades
export const RANKS=['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
export const CATEGORIES=['high','pair','color','sequence','pure','trail'];
const card=c=>({rank:RANKS.indexOf(c[0])+2,suit:SUITS.indexOf(c[1])});

/** Comparable key (array, compared lexicographically) and category of a three-card hand. */
export function handKey(cards){
 const cs=cards.map(card).sort((a,b)=>b.rank-a.rank||b.suit-a.suit);
 const ranks=cs.map(c=>c.rank),flush=cs.every(c=>c.suit===cs[0].suit);
 const wheel=ranks[0]===14&&ranks[1]===3&&ranks[2]===2;  // A-2-3 is the lowest sequence
 const seq=wheel||ranks[0]-ranks[1]===1&&ranks[1]-ranks[2]===1;
 const top=wheel?cs[1]:cs[0],points=wheel?6:ranks.reduce((a,b)=>a+b,0);
 if(ranks[0]===ranks[2])return{category:'trail',key:[5,ranks[0],cs[0].suit]};
 if(seq&&flush)return{category:'pure',key:[4,points,top.suit]};
 if(seq)return{category:'sequence',key:[3,points,top.suit]};
 if(flush)return{category:'color',key:[2,...ranks,cs[0].suit]};
 if(ranks[0]===ranks[1]||ranks[1]===ranks[2]){
  const pair=ranks[1],pairSuit=Math.max(...cs.filter(c=>c.rank===pair).map(c=>c.suit));
  return{category:'pair',key:[1,pair,points,pairSuit]};
 }
 return{category:'high',key:[0,...ranks,cs[0].suit]};
}
const compare=(a,b)=>{for(let i=0;i<Math.max(a.length,b.length);i++){const d=(a[i]??-1)-(b[i]??-1);if(d)return d;}return 0;};

export function cards3Model(game){
 const config={family:'cards3',options:game.options.map(o=>o.id),payout_x100:game.payout_x100,deck:52,cards_per_hand:3,rng:'HMAC-SHA256 counter, Fisher-Yates'};
 const hash=createHash('sha256').update(canonical(config)).digest('hex');
 // Wallet liability uses the integer ceiling of the payout multiplier.
 return Object.freeze({gameId:game.id,version:`${game.id}-cards3-v1`,hash,maxMultiplier:Math.ceil(game.payout_x100/100),targetRtp:game.payout_x100/100/game.options.length,config});
}

export function drawCards3(model,seedHex){
 const rng=createRng(seedHex,`${model.version}:deal`),deck=RANKS.flatMap(r=>SUITS.map(s=>r+s));
 for(let i=deck.length-1;i>0;i--){const j=rng.int(i+1);[deck[i],deck[j]]=[deck[j],deck[i]];}
 const ids=model.config.options,hands={},ranks={};
 ids.forEach((id,i)=>{hands[id]=deck.slice(i*3,i*3+3);const h=handKey(hands[id]);ranks[id]={category:h.category,key:h.key};});
 const winner=ids.reduce((best,id)=>compare(ranks[id].key,ranks[best].key)>0?id:best,ids[0]);
 return {outcome:winner,winners:[winner],hands,categories:Object.fromEntries(ids.map(id=>[id,ranks[id].category]))};
}

export const cards3Payout=(game,result,bet)=>result.winners.includes(bet.option_id)?BigInt(bet.stake_minor)*BigInt(game.payout_x100)/100n:0n;
