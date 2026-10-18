/** Localized names and rules for roulette / SicBo table games. */
import {locale} from '../../shared/i18n.mjs';

const NAMES={zero:['0','0','0'],d1:['1-12','1-12','1-12'],d2:['13-24','13-24','13-24'],d3:['25-36','25-36','25-36'],
 red:['Red','红','أحمر'],black:['Black','黑','أسود'],even:['Even','双','زوجي'],odd:['Odd','单','فردي'],single:['Single','单','فردي'],double:['Double','双','زوجي'],
 big:['Big','大','كبير'],small:['Small','小','صغير'],triple:['Any Triple','任意豹子','أي ثلاثية']};
const ix=()=>({zh:1,ar:2}[locale()]||0);
export const tableOptionName=id=>NAMES[id]?.[ix()]||id;

const R=[
 n=>[`1. Pick a chip and tap the board; up to ${n} bets per round.`,'2. When betting closes the ball is spun on a European single-zero wheel (0-36).',
  '3. 0 pays x36; 1-12 / 13-24 / 25-36 pay x3; Red / Black and Odd / Even (Single / Double) pay x2. Payouts include the stake.','4. When 0 comes up, all bets other than 0 lose.'],
 n=>[`1. 选择筹码后点击下注区，每局最多押 ${n} 个区域。`,'2. 停止下注后在欧式单零轮盘（0–36）上开球。',
  '3. 押 0 赔 ×36；1-12 / 13-24 / 25-36 赔 ×3；红 / 黑、单 / 双赔 ×2（均含本金）。','4. 开出 0 时，除押 0 外的下注全部不中。'],
 n=>[`1. اختر رقاقة وانقر على الطاولة؛ حتى ${n} رهانات في الجولة.`,'2. بعد إغلاق الرهان تدور الكرة على عجلة أوروبية بصفر واحد (0-36).',
  '3. الصفر ×36؛ 1-12 / 13-24 / 25-36 ×3؛ أحمر / أسود وفردي / زوجي ×2 (شاملاً الرهان).','4. عند ظهور 0 تخسر كل الرهانات ما عدا الصفر.'],
];
const S=[
 n=>[`1. Pick a chip and tap BIG, SMALL or ANY TRIPLE; up to ${n} bets per round.`,'2. Three dice are shaken in the cup and revealed when betting closes.',
  '3. BIG: total 11-17 pays x2. SMALL: total 4-10 pays x2. Any triple loses BIG and SMALL.','4. ANY TRIPLE: all three dice the same pays x35. Payouts include the stake.'],
 n=>[`1. 选择筹码后点击“大”“小”或“任意豹子”，每局最多押 ${n} 个区域。`,'2. 三颗骰子在骰盅中摇动，停止下注后开盅。',
  '3. 大：点数和 11–17 赔 ×2；小：点数和 4–10 赔 ×2；开出豹子时大、小都不中。','4. 任意豹子：三颗骰子点数相同赔 ×35（均含本金）。'],
 n=>[`1. اختر رقاقة وانقر كبير أو صغير أو أي ثلاثية؛ حتى ${n} رهانات في الجولة.`,'2. تُهز ثلاثة نرد في الكوب وتُكشف عند إغلاق الرهان.',
  '3. كبير: المجموع 11-17 ×2. صغير: المجموع 4-10 ×2. أي ثلاثية تُخسر الكبير والصغير.','4. أي ثلاثية: النرد الثلاثة متطابقة ×35 (شاملاً الرهان).'],
];
export const tableRules=game=>(game.id==='sicbo'?S:R)[ix()](game.maxOptionsPerRound).join('\n');
