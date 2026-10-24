/** Localized "How to play" text generated from a wheel-family game definition. */
import {locale} from './i18n.mjs';

const W={
 zh:{pick:n=>`1. 选择筹码后点击下注区，每局最多押 ${n} 个选项。`,time:s=>`2. 每局下注 ${s} 秒，倒计时结束后开奖。`,
  pay:list=>`3. 开出的结果与你押注的相同即中奖，按倍数派奖（含本金）：${list}。`,group:(n,m,items)=>`${n} ×${m}：开出 ${items} 中任意一个即中奖。`,
  special:(n,items)=>`开出“${n}”时，${items} 全部中奖。`,extra:n=>`偶尔触发神奖：额外再开 ${n} 个中奖项。`,
  reel:'每局开奖后小转轴可能给出：额外加中 1–3 个、全部 ×2/×3，或开出彩金。',jackpot:'彩金池：每笔押注的 2% 进入彩金池；开出彩金时，中奖玩家按押注档位瓜分彩金池的 10%–70%。',sep:'，'},
 en:{pick:n=>`1. Pick a chip and tap a betting spot; up to ${n} options per round.`,time:s=>`2. Betting lasts ${s} seconds, then the result is drawn.`,
  pay:list=>`3. If the result matches your bet you win its multiplier (stake included): ${list}.`,group:(n,m,items)=>`${n} ×${m}: wins if any of ${items} is drawn.`,
  special:(n,items)=>`When "${n}" is drawn, ${items} all win.`,extra:n=>`A rare god prize adds ${n} more winning options.`,
  reel:'After each draw a mini reel may add 1-3 extra winners, multiply all wins x2/x3, or award the jackpot.',jackpot:'Jackpot: 2% of every bet feeds the pool; on a jackpot draw winning players share 10%-70% of the pool by bet size.',sep:', '},
 ar:{pick:n=>`1. اختر رقاقة وانقر مكان الرهان؛ حتى ${n} خيارات في الجولة.`,time:s=>`2. يستمر الرهان ${s} ثانية ثم تُسحب النتيجة.`,
  pay:list=>`3. إذا طابقت النتيجة رهانك تربح مضاعفه (شاملاً الرهان): ${list}.`,group:(n,m,items)=>`${n} ×${m}: يربح إذا سُحب أي من ${items}.`,
  special:(n,items)=>`عند سحب "${n}" يربح ${items} جميعاً.`,extra:n=>`جائزة نادرة تضيف ${n} خيارات رابحة أخرى.`,
  reel:'بعد كل سحب قد تضيف بكرة صغيرة 1-3 فائزين أو تضاعف الأرباح ×2/×3 أو تمنح الجائزة الكبرى.',jackpot:'الجائزة الكبرى: 2% من كل رهان تذهب للمجمع؛ عند سحبها يتقاسم الفائزون 10%-70% حسب حجم الرهان.',sep:'، '},
};
const NAMES={butterfly:['蝴蝶鱼','سمكة الفراشة'],yellowfish:['黄鱼','السمكة الصفراء'],blackfish:['黑鱼','السمكة السوداء'],greenfish:['绿鱼','السمكة الخضراء'],guppy:['孔雀鱼','غوبي'],swordfish:['剑鱼','سمكة أبو سيف'],goldjelly:['金水母','قنديل ذهبي'],manta:['魔鬼鱼','شيطان البحر'],goldwhale:['金鲸鱼','الحوت الذهبي'],swordking:['剑鱼王','ملك أبو سيف'],harrierking:['鹞鱼王','ملك الراي'],agate:['玛瑙乌贼','الحبار العقيقي'],thunderjelly:['雷霆水母','قنديل الرعد'],kingcrab:['螃蟹王','ملك السلطعون'],kingoctopus:['章鱼王','ملك الأخطبوط'],spinnercrab:['转盘蟹','سلطعون العجلة'],hammercrab:['锤蟹','سلطعون المطرقة'],whirlpool:['漩涡鱼','سمكة الدوامة'],joker:['小丑','الجوكر'],banana:['香蕉','موز'],burger:['汉堡','برغر'],pufferfish:['河豚','سمكة منتفخة'],allfruits:['全部水果','كل الفواكه'],allmeat:['全部肉类','كل اللحوم'],clownfish:['小丑鱼','سمكة المهرج'],bluetang:['蓝倒吊','سمكة زرقاء'],angelfish:['神仙鱼','سمكة الملاك'],lanternfish:['灯笼鱼','سمكة الفانوس'],seaturtle:['海龟','سلحفاة بحرية'],shark:['鲨鱼','قرش'],goldturtle:['金龟','سلحفاة ذهبية'],tomato:['番茄','طماطم'],corn:['玉米','ذرة'],carrot:['胡萝卜','جزر'],lettuce:['生菜','خس'],shrimp:['虾','روبيان'],fish:['鱼','سمك'],steak:['牛排','ستيك'],chicken:['烤鸡','دجاج'],salad:['沙拉','سلطة'],pizza:['披萨','بيتزا'],broccoli:['西兰花','بروكلي'],crab:['螃蟹','سلطعون'],goat:['山羊','ماعز'],horse:['马','حصان'],deer:['鹿','غزال'],bull:['公牛','ثور'],wolf:['狼','ذئب'],leopard:['豹','فهد'],eagle:['鹰','نسر'],tiger:['虎','نمر'],herbivores:['食草动物','آكلات العشب'],carnivores:['食肉动物','آكلات اللحوم'],turnip:['萝卜','لفت'],mushroom:['蘑菇','فطر'],sausage:['香肠','نقانق'],drumstick:['炸鸡腿','فخذ دجاج'],cabbage:['卷心菜','ملفوف'],hotdog:['热狗','هوت دوغ'],kebab:['烤串','كباب'],ham:['火腿','لحم مدخن'],rabbit:['兔子','أرنب'],cow:['奶牛','بقرة'],sheep:['绵羊','خروف'],fox:['狐狸','ثعلب'],bear:['熊','دب'],lion:['狮子','أسد'],grass:['草料大奖','جائزة العشب'],meat:['肉食大奖','جائزة اللحم'],grape:['葡萄','عنب'],lobster:['龙虾','كركند'],beef:['牛肉','لحم بقري'],cherry:['樱桃','كرز'],lemon:['柠檬','ليمون'],orange:['橙子','برتقال'],plum:['李子','برقوق'],bell:['铃铛','جرس'],watermelon:['西瓜','بطيخ'],seven:['幸运 7','سبعة'],star:['星星','نجمة'],apple:['苹果','تفاح'],mango:['芒果','مانجو'],strawberry:['草莓','فراولة'],lucky:['幸运','محظوظ'],superlucky:['超级幸运','محظوظ جداً'],leo:['狮子座','الأسد'],aries:['白羊座','الحمل'],libra:['天秤座','الميزان'],scorpio:['天蝎座','العقرب'],virgo:['处女座','العذراء'],taurus:['金牛座','الثور'],sagittarius:['射手座','القوس'],aquarius:['水瓶座','الدلو'],courage:['勇气','الشجاعة'],wisdom:['智慧','الحكمة'],strength:['力量','القوة']};
// Game-specific option names [en, zh, ar] where ids are generic.
const GAME_NAMES={
 glorycup:{team1:['Morocco','摩洛哥','المغرب'],team2:['Netherlands','荷兰','هولندا'],team3:['Portugal','葡萄牙','البرتغال'],team4:['Germany','德国','ألمانيا'],team5:['Brazil','巴西','البرازيل'],team6:['Argentina','阿根廷','الأرجنتين'],team7:['Spain','西班牙','إسبانيا'],team8:['France','法国','فرنسا']},
 footballleague:{club1:['Lions','雄狮','الأسود'],club2:['Eagles','雄鹰','النسور'],club3:['Stags','雄鹿','الأيائل'],club4:['Wolves','群狼','الذئاب'],club5:['Tridents','三叉戟','الرماح'],club6:['Tigers','猛虎','النمور'],club7:['Castle','城堡','القلعة'],club8:['Pegasus','飞马','الحصان المجنح']},
};
let current=null;
export const optionName=(id,game=current)=>{const l=locale(),g=GAME_NAMES[game]?.[id];if(g)return g[l==='zh'?1:l==='ar'?2:0];if(/^club\d+$/.test(id)&&game==='bountyfootball')return 'X'+id.slice(4);const n=NAMES[id];return n&&l!=='en'?n[l==='zh'?0:1]:id.replace(/^\w/,c=>c.toUpperCase());};
const label=id=>optionName(id);

export function wheelRules(game){
 current=game.id;const L=W[locale()]||W.en,drawn=game.options.filter(o=>!o.covers),groups=game.options.filter(o=>o.covers);
 const lines=[L.pick(game.maxOptionsPerRound),L.time(game.round.betMs/1000),L.pay(drawn.map(o=>`${label(o.id)} ×${o.multiplier}`).join(L.sep))];
 for(const g of groups)lines.push(L.group(label(g.id),g.multiplier,g.covers.map(label).join('/')));
 for(const s of game.specials||[])lines.push(L.special(label(s.id),game.options.filter(o=>o.group===s.covers).map(o=>label(o.id)).join('/')));
 const extra=game.bonus?.table?.find(x=>x.type==='extra');
 if(game.bonus?.jackpot)lines.push(L.reel,L.jackpot);else if(extra)lines.push(L.extra(extra.value));
 return lines.join('\n');
}
