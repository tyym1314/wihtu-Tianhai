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
});
export const CASINO_IDS=Object.freeze(Object.keys(CASINO_GAMES));
export const isCasinoGame=id=>Object.hasOwn(CASINO_GAMES,id);
