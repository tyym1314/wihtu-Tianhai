/**
 * Casino games (shared round & instant probability games). Shared by server and client.
 * Amounts are minor units (scale 2: 100 minor = 1 coin).
 */
const coins=n=>String(n*100);
const CHIPS=Object.freeze([coins(100),coins(1000),coins(10000),coins(50000),coins(100000)]);

export const CASINO_GAMES=Object.freeze({
 lionfeast:Object.freeze({
  id:'lionfeast',family:'wheel',reference:'GreedyLion',name:'Lion Feast',zh:'雄狮盛宴',ar:'وليمة الأسد',
  round:Object.freeze({betMs:20000,drawMs:7000,showMs:5000}),
  chips:CHIPS,maxOptionsPerRound:6,maxStakePerRound:coins(1000000),
  options:Object.freeze([
   {id:'tomato',multiplier:5,group:'veg'},{id:'corn',multiplier:5,group:'veg'},{id:'carrot',multiplier:5,group:'veg'},{id:'lettuce',multiplier:5,group:'veg'},
   {id:'shrimp',multiplier:10,group:'meat'},{id:'fish',multiplier:15,group:'meat'},{id:'steak',multiplier:25,group:'meat'},{id:'chicken',multiplier:45,group:'meat'},
  ].map(Object.freeze)),
  // Rare outcomes that pay every option of a group at its own multiplier.
  specials:Object.freeze([{id:'salad',covers:'veg',probability:0.0005},{id:'pizza',covers:'meat',probability:0.0005}].map(Object.freeze)),
 }),
 rocketrush:Object.freeze({
  id:'rocketrush',family:'crash',reference:'RocketStar2 / Crash / CrashStar',name:'Rocket Rush',zh:'火箭冲天',ar:'اندفاع الصاروخ',
  round:Object.freeze({betMs:8000,showMs:3500}),
  chips:CHIPS,maxOptionsPerRound:2,maxStakePerRound:coins(200000),
  // Two independent bet panels per player, each with an optional auto cash-out.
  options:Object.freeze([{id:'a'},{id:'b'}].map(Object.freeze)),
  rtp:0.97,maxMultiplier:1000,autoCashout:Object.freeze({min_x100:101,max_x100:100000}),
 }),
 royalpatti:Object.freeze({
  id:'royalpatti',family:'cards3',reference:'TeenPatti',name:'Royal Teen Patti',zh:'皇家三张',ar:'تين باتي الملكية',
  round:Object.freeze({betMs:15000,drawMs:7000,showMs:4000}),
  chips:CHIPS,maxOptionsPerRound:3,maxStakePerRound:coins(1000000),
  options:Object.freeze([{id:'ruby'},{id:'jade'},{id:'sapphire'}].map(Object.freeze)),
  // Winning hand pays x2.91 (stake included): 97% RTP with three equally likely hands.
  payout_x100:291,
 }),
 skypalace:Object.freeze({
  id:'skypalace',family:'slot',kind:'instant',reference:'Olympus',name:'Sky Palace',zh:'天空神殿',ar:'قصر السماء',
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
   orbs:{base:[{x:2,w:300},{x:3,w:200},{x:4,w:140},{x:5,w:110},{x:6,w:80},{x:8,w:60},{x:10,w:45},{x:12,w:25},{x:15,w:18},{x:20,w:12},{x:25,w:8},{x:50,w:4},{x:100,w:2}],
         free:[{x:2,w:300},{x:3,w:200},{x:4,w:140},{x:5,w:110},{x:6,w:80},{x:8,w:60},{x:10,w:45},{x:12,w:25},{x:15,w:18},{x:20,w:12},{x:25,w:8},{x:50,w:4},{x:100,w:2},{x:250,w:1},{x:500,w:1}]},
   weights:{base:{crown:120,hourglass:140,ring:160,chalice:190,redgem:246,purplegem:278,yellowgem:322,greengem:364,bluegem:406,scatter:44,orb:35},
            free:{crown:120,hourglass:140,ring:160,chalice:190,redgem:246,purplegem:278,yellowgem:322,greengem:364,bluegem:406,scatter:40,orb:42}},
  }),
 }),
});
export const CASINO_IDS=Object.freeze(Object.keys(CASINO_GAMES));
export const isCasinoGame=id=>Object.hasOwn(CASINO_GAMES,id);
