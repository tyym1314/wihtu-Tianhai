/**
 * Casino games (shared round & instant probability games). Shared by server and client.
 * Amounts are minor units (scale 2: 100 minor = 1 coin).
 */
const coins=n=>String(n*100);
const CHIPS=Object.freeze([coins(100),coins(1000),coins(10000),coins(50000),coins(100000)]);

const CHIPS2=Object.freeze([coins(1000),coins(5000),coins(10000),coins(50000),coins(100000)]);
/** A Greedy-style wheel: four x5 items, four higher items, optional all-of-a-group specials and group bets. */
function wheelGame(id,name,{veg,meat,specials=[],groups=[],chips,round}){
 const options=[...veg.map(o=>({id:o,multiplier:5,group:'veg'})),...meat.map(([o,m])=>({id:o,multiplier:m,group:'meat'}))];
 const all={veg:veg,meat:meat.map(([o])=>o)};
 return Object.freeze({id,family:'wheel',reference:name,name,zh:name,ar:name,round:Object.freeze(round),chips,maxOptionsPerRound:groups.length?10:6,maxStakePerRound:coins(1000000),
  options:Object.freeze([...options,...groups.map(g=>({id:g.id,multiplier:g.multiplier,covers:all[g.group]}))].map(Object.freeze)),
  specials:Object.freeze(specials.map((sp,i)=>Object.freeze({id:sp,covers:i?'meat':'veg',probability:0.0005})))});
}
const SLOT_STAKES=Object.freeze([coins(10),coins(50),coins(100),coins(500),coins(1000),coins(5000)]);
const sym=list=>list.map(([id,[a,b,c]])=>({id,pays:[[3,a],[4,b],[5,c]]}));
// Standard 12 paylines on 5x3 (row index per reel, 0 = top).
const LINES_12=[[1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],[0,0,1,2,2],[2,2,1,0,0],[1,0,0,0,1],[1,2,2,2,1],[0,1,1,1,0],[2,1,1,1,2],[1,1,0,1,1]];
/** 2000-ways cascading slot (4-5-5-5-4): golden symbols on reels 2-4 turn wild when they win; cascades raise the multiplier. */
function waysSlot(id,name,scatter,symbols){
 const w={};symbols.forEach(([s],i)=>{w[s]=[10,14,18,24,30,36,44,52][i];});
 return Object.freeze({id,family:'slot',kind:'instant',reference:name,name,zh:name,ar:name,stakes:SLOT_STAKES,
  slot:Object.freeze({pay:'ways',columns:5,rows:[4,5,5,5,4],waysDivisor:20,targetRtp:0.97,maxWin:5000,payScale:0.0552,
   wild:{id:'wild',reels:[1,2,3],maxPerReel:2},golden:{reels:[1,2,3],chanceBp:900},
   symbols:sym(symbols),scatter:{id:scatter,pays:[]},
   cascade:{base:[1,2,3,5],free:[2,4,6,10]},freeSpins:{trigger:3,award:10,perExtra:2,retrigger:2,maxPlayed:100},
   weights:{base:{...w,wild:[0,3,3,3,0],[scatter]:4}}})});
}
const range=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
const DICE=[1,2,3,4,5,6].flatMap(a=>[1,2,3,4,5,6].flatMap(b=>[1,2,3,4,5,6].map(c=>[a,b,c]))),sum=d=>d[0]+d[1]+d[2],triple=d=>d[0]===d[1]&&d[1]===d[2];
const RED=[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36],BLACK=range(1,36).filter(n=>!RED.includes(n));
/** Every option drawn with weights that give each the same RTP (no specials or groups). */
function plainWheel(id,name,items,{maxOptions,chips=CHIPS2,bonus,round={betMs:25000,drawMs:8000,showMs:5000}}){
 return Object.freeze({id,family:'wheel',reference:name,name,zh:name,ar:name,round:Object.freeze(round),chips,maxOptionsPerRound:maxOptions,maxStakePerRound:coins(1000000),
  options:Object.freeze(items.map(([o,m])=>Object.freeze({id:o,multiplier:m}))),...(bonus?{bonus:Object.freeze(bonus)}:{})});
}
/** European single-zero roulette with the reference's simplified bet board. */
function rouletteGame(id,name,bets){
 return Object.freeze({id,family:'wheel',reference:name,name,zh:name,ar:name,round:Object.freeze({betMs:20000,drawMs:9000,showMs:5000}),chips:CHIPS2,maxOptionsPerRound:8,maxStakePerRound:coins(1000000),
  draw:Object.freeze(range(0,36).map(n=>Object.freeze({id:'n'+n,weight:1}))),
  options:Object.freeze(bets.map(([o,m,nums])=>Object.freeze({id:o,multiplier:m,covers:nums.map(n=>'n'+n)})))});
}
function crashGame(id,name){
 return Object.freeze({id,family:'crash',reference:name,name,zh:name,ar:name,round:Object.freeze({betMs:8000,showMs:3500}),chips:CHIPS2,maxOptionsPerRound:2,maxStakePerRound:coins(200000),
  options:Object.freeze([{id:'a'},{id:'b'}].map(Object.freeze)),rtp:0.97,maxMultiplier:1000,autoCashout:Object.freeze({min_x100:101,max_x100:100000})});
}
export const CASINO_GAMES=Object.freeze({
 greedylion:Object.freeze({
  id:'greedylion',released:true,family:'wheel',reference:'GreedyLion',name:'GreedyLion',zh:'GreedyLion',ar:'GreedyLion',
  round:Object.freeze({betMs:20000,drawMs:7000,showMs:5000}),
  chips:CHIPS,maxOptionsPerRound:6,maxStakePerRound:coins(1000000),
  options:Object.freeze([
   {id:'tomato',multiplier:5,group:'veg'},{id:'corn',multiplier:5,group:'veg'},{id:'carrot',multiplier:5,group:'veg'},{id:'lettuce',multiplier:5,group:'veg'},
   {id:'shrimp',multiplier:10,group:'meat'},{id:'fish',multiplier:15,group:'meat'},{id:'steak',multiplier:25,group:'meat'},{id:'chicken',multiplier:45,group:'meat'},
  ].map(Object.freeze)),
  // Rare outcomes that pay every option of a group at its own multiplier.
  specials:Object.freeze([{id:'salad',covers:'veg',probability:0.0005},{id:'pizza',covers:'meat',probability:0.0005}].map(Object.freeze)),
 }),
 rocketstar2:Object.freeze({
  id:'rocketstar2',released:true,family:'crash',reference:'RocketStar2',name:'RocketStar2',zh:'RocketStar2',ar:'RocketStar2',
  round:Object.freeze({betMs:8000,showMs:3500}),
  chips:CHIPS,maxOptionsPerRound:2,maxStakePerRound:coins(200000),
  // Two independent bet panels per player, each with an optional auto cash-out.
  options:Object.freeze([{id:'a'},{id:'b'}].map(Object.freeze)),
  rtp:0.97,maxMultiplier:1000,autoCashout:Object.freeze({min_x100:101,max_x100:100000}),
 }),
 teenpatti:Object.freeze({
  id:'teenpatti',released:true,family:'cards3',reference:'TeenPatti',name:'TeenPatti',zh:'TeenPatti',ar:'TeenPatti',
  round:Object.freeze({betMs:15000,drawMs:7000,showMs:4000}),
  chips:Object.freeze([coins(100),coins(1000),coins(10000),coins(100000)]),maxOptionsPerRound:3,maxStakePerRound:coins(1000000),
  options:Object.freeze([{id:'ruby'},{id:'jade'},{id:'sapphire'}].map(Object.freeze)),
  // Winning hand pays x2.91 (stake included): 97% RTP with three equally likely hands.
  payout_x100:291,
 }),
 olympus:Object.freeze({
  id:'olympus',released:true,family:'slot',kind:'instant',reference:'Olympus',name:'Olympus',zh:'Olympus',ar:'Olympus',
  stakes:Object.freeze([coins(10),coins(50),coins(100),coins(500),coins(1000),coins(5000)]),
  slot:Object.freeze({
   pay:'anywhere',columns:6,rows:5,targetRtp:0.97,maxWin:5000,
   // Pays in hundredths of the stake for 8-9 / 10-11 / 12+ copies anywhere (same table as the reference game).
   symbols:[
    {id:'crown',bands:[[8,500],[10,1000],[12,2500]]},{id:'hourglass',bands:[[8,240],[10,600],[12,1500]]},
    {id:'ring',bands:[[8,200],[10,400],[12,1200]]},{id:'chalice',bands:[[8,160],[10,300],[12,800]]},
    {id:'redgem',bands:[[8,100],[10,140],[12,600]]},{id:'purplegem',bands:[[8,80],[10,120],[12,500]]},
    {id:'yellowgem',bands:[[8,60],[10,100],[12,400]]},{id:'greengem',bands:[[8,40],[10,80],[12,300]]},
    {id:'bluegem',bands:[[8,25],[10,75],[12,200]]},
   ],
   scatter:{bands:[[4,200],[5,400],[6,1000]]},
   freeSpins:{trigger:4,award:5,retrigger:3,retriggerAward:3,maxPlayed:100},
   // Buying the free spins feature costs 10.2x the stake (feature mean ~9.89x -> 97%).
   buy:{price_x100:1020},
   orbs:{base:[{x:2,w:300},{x:3,w:200},{x:4,w:140},{x:5,w:110},{x:6,w:80},{x:8,w:60},{x:10,w:45},{x:12,w:25},{x:15,w:18},{x:20,w:12},{x:25,w:8},{x:50,w:4},{x:100,w:2}],
         free:[{x:2,w:300},{x:3,w:200},{x:4,w:140},{x:5,w:110},{x:6,w:80},{x:8,w:60},{x:10,w:45},{x:12,w:25},{x:15,w:18},{x:20,w:12},{x:25,w:8},{x:50,w:4},{x:100,w:2},{x:250,w:1},{x:500,w:1}]},
   weights:{base:{crown:120,hourglass:140,ring:160,chalice:190,redgem:246,purplegem:278,yellowgem:322,greengem:364,bluegem:406,scatter:44,orb:35},
            free:{crown:120,hourglass:140,ring:160,chalice:190,redgem:246,purplegem:278,yellowgem:322,greengem:364,bluegem:406,scatter:40,orb:42}},
  }),
 }),

 // ---- Batch 1 (Greedy family). Unreleased until their concept art and front-ends ship. ----
 greedycat2:wheelGame('greedycat2','GreedyCat2',{veg:['tomato','corn','carrot','broccoli'],meat:[['fish',10],['crab',15],['steak',25],['chicken',45]],specials:['salad','pizza'],chips:CHIPS2,round:{betMs:25000,drawMs:7000,showMs:5000}}),
 greedybrutal:wheelGame('greedybrutal','GreedyBrutal',{veg:['goat','horse','deer','bull'],meat:[['wolf',10],['leopard',15],['eagle',25],['tiger',45]],specials:['herbivores','carnivores'],chips:CHIPS2,round:{betMs:25000,drawMs:7000,showMs:5000}}),
 bigeater:wheelGame('bigeater','BigEater',{veg:['tomato','turnip','mushroom','corn'],meat:[['sausage',10],['drumstick',15],['shrimp',25],['steak',45]],specials:['salad','pizza'],chips:CHIPS2,round:{betMs:30000,drawMs:7000,showMs:5000}}),
 // GreedyKing adds group bets: SALAD pays x1.25 on any vegetable, PIZZA x4.37 on any meat (same ~97% RTP).
 greedyking:wheelGame('greedyking','GreedyKing',{veg:['carrot','cabbage','corn','tomato'],meat:[['hotdog',10],['kebab',15],['ham',25],['steak',45]],specials:[],
  groups:[{id:'salad',multiplier:1.25,group:'veg'},{id:'pizza',multiplier:4.37,group:'meat'}],chips:Object.freeze([coins(1000),coins(5000),coins(10000),coins(100000),coins(300000)]),round:{betMs:30000,drawMs:7000,showMs:5000}}),

 // FruitParty: 8-fruit machine; after each draw a mini reel may add fruits, multiply, or award the jackpot.
 fruitparty:Object.freeze({
  id:'fruitparty',family:'wheel',reference:'FruitParty',name:'FruitParty',zh:'FruitParty',ar:'FruitParty',
  round:Object.freeze({betMs:25000,drawMs:9000,showMs:5000}),chips:Object.freeze([coins(1000),coins(5000),coins(10000),coins(50000)]),maxOptionsPerRound:8,maxStakePerRound:coins(1000000),
  options:Object.freeze([{id:'cherry',multiplier:5},{id:'lemon',multiplier:5},{id:'orange',multiplier:5},{id:'plum',multiplier:5},{id:'bell',multiplier:10},{id:'watermelon',multiplier:10},{id:'seven',multiplier:20},{id:'star',multiplier:40}].map(Object.freeze)),
  bonus:Object.freeze({liabilityMultiplier:500,
   // Jackpot: 2% of every accepted stake feeds the App's pool; on a jackpot draw each winning bet shares
   // pool x tier% (by the player's winning stake this round) in proportion to its stake.
   jackpot:Object.freeze({contributionBps:200,tiers:[[0,10],[coins(10000),30],[coins(100000),50],[coins(1000000),70]]}),
   table:Object.freeze([{type:'none',weight:9780},{type:'extra',value:1,weight:50},{type:'extra',value:2,weight:25},{type:'extra',value:3,weight:10},{type:'multiplier',value:2,weight:60},{type:'multiplier',value:3,weight:30},{type:'jackpot',weight:45}])}),
 }),

 // ---- Slots on the lines/ways engine (unreleased until art ships). Pays: hundredths of line bet (lines) or of total bet per way / waysDivisor (ways).
 oceanslot:Object.freeze({id:'oceanslot',family:'slot',kind:'instant',reference:'OceanSlot',name:'OceanSlot',zh:'OceanSlot',ar:'OceanSlot',stakes:SLOT_STAKES,
  slot:Object.freeze({pay:'lines',columns:5,rows:3,targetRtp:0.97,maxWin:2000,payScale:44.3,
   lines:LINES_12,wild:{id:'wild',reels:[1,2,3,4],maxPerReel:1},
   symbols:sym([['pearl',[300,1500,5000]],['shell',[200,800,3000]],['starfish',[150,600,2000]],['seahorse',[120,500,1500]],['turtle',[100,400,1200]],['A',[60,200,600]],['K',[50,160,500]],['Q',[40,120,400]],['J',[30,100,300]],['ten',[20,80,250]]]),
   scatter:{id:'chest',pays:[[3,200],[4,1000],[5,5000]]},freeSpins:{trigger:3,award:8,perExtra:4,retrigger:4,multiplier:2,maxPlayed:60},
   weights:{base:{pearl:14,shell:20,starfish:26,seahorse:32,turtle:38,A:60,K:64,Q:68,J:72,ten:76,wild:[0,26,26,26,26],chest:9}}})}),
 mahjongslot:waysSlot('mahjongslot','MahjongSlot','hu',[['green',[1500,6000,10000]],['red',[1000,4000,8000]],['white',[800,2000,6000]],['wan',[600,1500,4000]],['tiao',[300,800,2000]],['tong',[300,800,2000]],['five',[200,400,1000]],['two',[100,300,600]]]),
 cleopatraslot:waysSlot('cleopatraslot','CleopatraSlot','cleopatra',[['scarab',[1500,6000,10000]],['ankh',[1000,4000,8000]],['eye',[800,2000,6000]],['vase',[600,1500,4000]],['A',[300,800,2000]],['K',[300,800,2000]],['Q',[200,400,1000]],['J',[100,300,600]]]),

 // ---- Round games on the wheel engine (unreleased until art ships). ----
 crazyfruit:wheelGame('crazyfruit','CrazyFruit',{veg:['orange','lemon','grape','cherry'],meat:[['apple',10],['watermelon',15],['mango',25],['strawberry',45]],specials:['lucky','superlucky'],chips:CHIPS2,round:{betMs:25000,drawMs:7000,showMs:5000}}),
 magiccard:plainWheel('magiccard','MagicCard',[['leo',100],['aries',4],['libra',4],['scorpio',5],['virgo',50],['taurus',25],['sagittarius',15],['aquarius',5]],{maxOptions:4,chips:Object.freeze([coins(1000),coins(5000),coins(10000),coins(30000)])}),
 bountyfootball:plainWheel('bountyfootball','BountyFootball',[['club2',2],['club5',5],['club8',8],['club18',18],['club20',20],['club30',30],['club50',50],['club66',66],['club88',88],['club100',100]],{maxOptions:10,chips:Object.freeze([coins(1000),coins(5000),coins(10000),coins(100000),coins(300000)])}),
 // FootballLeague / GloryCup: 8 clubs x40/x40/x12/x12/x6/x6/x4/x4; a rare "god prize" adds 3 extra winning clubs.
 footballleague:plainWheel('footballleague','FootballLeague',[['club1',40],['club2',40],['club3',12],['club4',12],['club5',6],['club6',6],['club7',4],['club8',4]],{maxOptions:8,bonus:{liabilityMultiplier:160,table:[{type:'none',weight:9953},{type:'extra',value:3,weight:47}]}}),
 glorycup:plainWheel('glorycup','GloryCup',[['team1',40],['team2',40],['team3',12],['team4',12],['team5',6],['team6',6],['team7',4],['team8',4]],{maxOptions:8,bonus:{liabilityMultiplier:160,table:[{type:'none',weight:9953},{type:'extra',value:3,weight:47}]}}),
 // SolomonMines: three chests, one wins; x2.91 (stake included) -> 97%.
 solomonmines:plainWheel('solomonmines','SolomonMines',[['courage',2.91],['wisdom',2.91],['strength',2.91]],{maxOptions:3,chips:Object.freeze([coins(1000),coins(5000),coins(10000),coins(50000)])}),
 roulette:rouletteGame('roulette','roulette',[['zero',36,[0]],['d1',3,range(1,12)],['d2',3,range(13,24)],['d3',3,range(25,36)],['red',2,RED],['black',2,BLACK],['even',2,range(1,36).filter(n=>n%2===0)],['odd',2,range(1,36).filter(n=>n%2)]]),
 roulettepro:rouletteGame('roulettepro','RoulettePro',[['zero',36,[0]],['d1',3,range(1,12)],['d2',3,range(13,24)],['d3',3,range(25,36)],['red',2,RED],['black',2,BLACK],['single',2,range(1,36).filter(n=>n%2)],['double',2,range(1,36).filter(n=>n%2===0)]]),
 // SicBo: three dice (216 equally likely); BIG 11-17 / SMALL 4-10 lose on any triple; ANY TRIPLE x35.
 sicbo:Object.freeze({id:'sicbo',family:'wheel',reference:'SicBo',name:'SicBo',zh:'SicBo',ar:'SicBo',round:Object.freeze({betMs:15000,drawMs:6000,showMs:5000}),
  chips:Object.freeze([coins(1000),coins(5000),coins(10000),coins(50000)]),maxOptionsPerRound:3,maxStakePerRound:coins(1000000),
  draw:Object.freeze(DICE.map(d=>Object.freeze({id:'d'+d.join(''),weight:1}))),
  options:Object.freeze([['big',2,d=>sum(d)>=11&&!triple(d)],['triple',35,triple],['small',2,d=>sum(d)<=10&&!triple(d)]].map(([o,m,f])=>Object.freeze({id:o,multiplier:m,covers:DICE.filter(f).map(d=>'d'+d.join(''))})))}),
 crash:crashGame('crash','Crash'),
 crashstar:crashGame('crashstar','CrashStar'),
});
/** Games playable by Apps; unreleased definitions exist for math and server work before their art ships. */
const preview=typeof process!=='undefined'&&process.env?.OASIS_CASINO_PREVIEW==='1'&&process.env?.OASIS_ENVIRONMENT!=='production'||typeof process!=='undefined'&&process.env?.OASIS_CASINO_PREVIEW==='test';
export const CASINO_IDS=Object.freeze(Object.keys(CASINO_GAMES).filter(id=>CASINO_GAMES[id].released||preview));
export const ALL_CASINO_DEFINITIONS=Object.freeze(Object.keys(CASINO_GAMES));
export const isCasinoGame=id=>CASINO_IDS.includes(id);
