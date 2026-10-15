/** Casino UI language (zh/en/ar). Order: session locale, ?locale=, launcher choice, device language. */
const DICT={
 connecting:['正在连接…','Connecting…','جارٍ الاتصال…'],
 balance:['余额','Balance','الرصيد'],
 round:['第 {0} 局','Round {0}','الجولة {0}'],
 betting:['下注中','Place bets','ضع رهانك'],
 drawing:['开奖中','Drawing','جارٍ السحب'],
 result:['本局结果','Result','النتيجة'],
 next:['下一局即将开始','Next round soon','الجولة التالية قريباً'],
 repeat:['重复上局','Repeat','كرر'],
 youWon:['恭喜赢得','You won','ربحت'],
 noWin:['本局未中奖','No win this round','لا فوز في هذه الجولة'],
 topWinners:['本局赢家','Top winners','الفائزون'],
 history:['开奖记录','History','السجل'],
 rules:['玩法规则','How to play','طريقة اللعب'],
 close:['关闭','Close','إغلاق'],
 sound:['声音','Sound','الصوت'],
 myBet:['我的押注','My bet','رهاني'],
 total:['全场','All','الكل'],
 insufficient:['余额不足','Insufficient balance','الرصيد غير كافٍ'],
 closed:['本局已停止下注','Betting is closed','أُغلق الرهان'],
 tooMany:['每局最多押 {0} 个选项','Up to {0} options per round','حتى {0} خيارات في الجولة'],
 limit:['已达本局押注上限','Round bet limit reached','تم بلوغ حد الرهان'],
 failed:['下注失败，请重试','Bet failed, please retry','فشل الرهان، أعد المحاولة'],
 offline:['网络连接中断，正在重连…','Connection lost, reconnecting…','انقطع الاتصال، جارٍ إعادة الاتصال…'],
 salad:['沙拉！所有蔬菜中奖','SALAD! All vegetables win','سلطة! كل الخضار تفوز'],
 pizza:['披萨！所有肉类中奖','PIZZA! All meats win','بيتزا! كل اللحوم تفوز'],
 fair:['公平校验','Provably fair','عدالة قابلة للتحقق'],
 fairText:['每局开始前公布结果承诺（SHA-256），开奖后公开种子，可自行校验。','Each round publishes a SHA-256 commitment before betting and reveals the seed after the draw.','تُنشر بصمة SHA-256 قبل كل جولة ويُكشف البذر بعد السحب.'],
 lionRules:['1. 选择筹码，点击食物下注，每局最多押 6 种。\n2. 每局下注 20 秒，倒计时结束后开奖。\n3. 开出的食物与您押注的相同即中奖，按该食物倍数派奖（含本金）：蔬菜 ×5，虾 ×10，鱼 ×15，牛排 ×25，烤鸡 ×45。\n4. 偶尔开出“沙拉”时所有蔬菜同时中奖，开出“披萨”时所有肉类同时中奖。',
  '1. Pick a chip and tap a dish to bet, up to 6 dishes per round.\n2. Betting lasts 20 seconds, then the wheel draws.\n3. If the drawn dish matches your bet you win its multiplier (stake included): vegetables ×5, shrimp ×10, fish ×15, steak ×25, roast chicken ×45.\n4. A rare SALAD pays every vegetable; a rare PIZZA pays every meat.',
  '1. اختر رقاقة وانقر طبقاً للرهان، حتى 6 أطباق في الجولة.\n2. يستمر الرهان 20 ثانية ثم تدور العجلة.\n3. إذا طابق الطبق المسحوب رهانك تربح مضاعفه (شاملاً الرهان): الخضار ×5، الروبيان ×10، السمك ×15، الستيك ×25، الدجاج المشوي ×45.\n4. السلطة النادرة تدفع لكل الخضار، والبيتزا النادرة تدفع لكل اللحوم.'],
};
const pick=v=>{v=String(v||'').toLowerCase();return v.startsWith('zh')?0:v.startsWith('ar')?2:v.startsWith('en')?1:null;};
let index=(()=>{try{const q=pick(new URLSearchParams(location.search).get('locale'));if(q!==null)return q;const s=pick(localStorage.getItem('oasis-locale'));if(s!==null)return s;}catch{}return pick(navigator.language)??0;})();
export const locale=()=>['zh','en','ar'][index];
export const isRtl=()=>index===2;
export function setLocale(v){const p=pick(v);if(p!==null){index=p;document.documentElement.lang=['zh-CN','en','ar'][p];}}
export function t(key,values){let s=(DICT[key]||[key,key,key])[index]||DICT[key]?.[1]||key;if(values)s=s.replace(/\{(\d+)\}/g,(_,i)=>values[i]??'');return s;}
setLocale(locale());
