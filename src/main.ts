import './style.css';
import { GameMotion } from './ui/motion';
import { HeroCharacter } from './ui/character';
import './ui/audio-controls.css';
import { AutoPlay, AUTO_PLAY_COUNTS } from './ui/autoplay';
import { GAME_CONFIG, INITIAL_BOARD, SYMBOLS } from './game/engine';
import type { Cell, RoundResult, SymbolId } from './game/types';
import { GameAudio } from './ui/audio';
import { t, type Locale, type TranslationKey } from './ui/i18n';

type Round = { id: string; requestId: string; epoch: number; bet: number; isFreeSpin: boolean; win: number; balanceBefore: number; balanceAfter: number; freeSpinsBefore: number; freeSpinsAfter: number; createdAt: string; engine: RoundResult };
type Session = { mode: 'demo'; sessionId: string; epoch: number; stateVersion: number; balance: number; betChoices: number[]; freeSpins: number; freeMultiplier: number; lockedBet: number | null; pendingRound: Round | null; mathVersion?: string };
type SpinResponse = { session: Session; round: Round };
const readPref = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const savePref = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private browsing */ } };
let locale: Locale = ['zh', 'en', 'ar'].includes(readPref('tt-language', 'zh')) ? readPref('tt-language', 'zh') as Locale : 'zh';
let turbo = readPref('tt-turbo', 'false') === 'true';
let session: Session | null = null;
let bet = 100;
let busy = false;
let previewing = false;
let autoplay: AutoPlay;
let roundWasAuto = false;
let lastWin = 0;
let displayBalance = 12000;
let retryRequestId: string | null = null;
let retryBet = 100;
let displayedBoard = INITIAL_BOARD;
const audio = new GameAudio();
audio.setEnabled(readPref('tt-sound', 'true') === 'true');
audio.setMusicEnabled(readPref('tt-music', 'true') === 'true');
audio.setSfxEnabled(readPref('tt-sfx', 'true') === 'true');
const volumePref = (key: string, fallback: number) => { const value = Number(readPref(key, String(fallback))); return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback; };
audio.setMusicVolume(volumePref('tt-music-volume', .6));
audio.setSfxVolume(volumePref('tt-sfx-volume', .85));
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const tr = (key: TranslationKey) => t(locale, key);
const copy = {
  zh: { edition: '雷霆王座', subtitle: '天空之上的宝石盛宴', ready: '集齐 8 个同类符号，即可赢取奖励', cascade: '连消', paid: '返还', empty: '这一轮未中奖', feature: '雷霆降临', bonusAward: '次免费旋转', enterBonus: '进入免费旋转', bonusOver: '免费旋转结束', preview: '特效预览', previewNote: '演出预览 · 不改变余额', bonusPreview: '免费转演出', megaPreview: '大奖演出', resetTitle: '重新开始试玩？', resetBody: '余额将恢复为 12,000 演示币，当前免费转和历史记录将被清除。', resetYes: '重新开始', cancel: '取消', target: '目标 RTP', version: '数值版本', limits: '倍率最高 100×，每转最多 24 次连消，单转最高返还 1,000 倍。上限纳入数值模型。', rulesIntro: '符号在任意位置累计达到 8 个即可中奖，无需相邻或连线。中奖后消除并补位，直到不再中奖。', rulesBonus: '结算盘面出现 4 个或更多 Scatter，获得 15 次免费旋转。免费转中出现 3 个或更多，再加 5 次。免费转沿用触发时的投入。', rulesMulti: '每个符号奖项按 0.01 币四舍五入。普通转中，倍率球相加后乘以本轮连消总奖励；无倍率时为 1×。免费转有中奖时收集倍率，并在本次免费转系列中累计（最高 100×）。', rulesDemo: '本地演示钱包，所有币仅用于试玩，不接入 App 余额。99% 是长期返还目标，不是每局中奖概率；实际验证见项目数值报告。', count: '数量', payout: '返还 / 投入', net: '净变化', copied: '结果已恢复', loading: '正在连接演示钱包…', connectFail: '暂时无法连接，点击重试', noMoney: '演示币不足，可在设置中重置试玩', resume: '继续本轮', ruleTitle: '雷霆法则', historyTitle: '旋转记录', settingsTitle: '你的游戏', on: '开启', off: '关闭', bonus: '免费转', network: '游戏状态已更新', screen: '沉浸模式', close: '关闭', settled: '已结算', normal: '普通转', replay: '演出结束', tryAgain: '重试连接' },
  en: { edition: 'THUNDER THRONE', subtitle: 'A treasure above the clouds', ready: 'Match 8 or more symbols anywhere to win', cascade: 'TUMBLE', paid: 'RETURN', empty: 'No win this round', feature: 'THUNDER AWAKENS', bonusAward: 'FREE SPINS', enterBonus: 'ENTER FREE SPINS', bonusOver: 'Free spins complete', preview: 'Effect preview', previewNote: 'Visual preview · balance unchanged', bonusPreview: 'Free spins preview', megaPreview: 'Mega win preview', resetTitle: 'Start a fresh demo?', resetBody: 'Restore 12,000 demo credits and clear free spins and round history.', resetYes: 'Start fresh', cancel: 'Cancel', target: 'TARGET RTP', version: 'Math version', limits: 'Multipliers cap at 100×, tumbles at 24 per spin, and a spin payout at 1,000× stake. Caps are part of the math model.', rulesIntro: '8 or more matching symbols anywhere on the grid pay. No adjacency or paylines required. Winning symbols disappear and refill until there are no more wins.', rulesBonus: '4+ Scatters on the final grid award 15 free spins. 3+ during free spins add 5. Free spins keep the triggering stake.', rulesMulti: 'Each symbol payout is rounded to 0.01 credit. In normal spins, multiplier balls add together and multiply the full tumble win. Without a ball, the multiplier is 1×. In free spins, balls on winning spins add to a persistent bonus multiplier, capped at 100×.', rulesDemo: 'Local demo wallet. Credits have no connection to your App balance. 99% is a long-run return target, not a chance of winning. See the project math report for simulation results.', count: 'COUNT', payout: 'RETURN / STAKE', net: 'NET', copied: 'Round recovered', loading: 'Connecting to demo wallet…', connectFail: 'Unable to connect. Tap retry.', noMoney: 'Not enough demo credits. Reset the demo in settings.', resume: 'RESUME ROUND', ruleTitle: 'THE RULES OF THUNDER', historyTitle: 'ROUND HISTORY', settingsTitle: 'YOUR GAME', on: 'On', off: 'Off', bonus: 'FREE SPIN', network: 'Game state refreshed', screen: 'Immersive view', close: 'Close', settled: 'Settled', normal: 'PAID SPIN', replay: 'Preview complete', tryAgain: 'Retry connection' },
  ar: { edition: 'عرش الرعد', subtitle: 'كنوز فوق السحاب', ready: 'اجمع 8 رموز متطابقة أو أكثر في أي مكان', cascade: 'تساقط', paid: 'العائد', empty: 'لا ربح في هذه الجولة', feature: 'قوة الرعد', bonusAward: 'لفات مجانية', enterBonus: 'بدء اللفات المجانية', bonusOver: 'انتهت اللفات المجانية', preview: 'معاينة المؤثرات', previewNote: 'معاينة فقط · لا يتغير الرصيد', bonusPreview: 'معاينة اللفات المجانية', megaPreview: 'معاينة الفوز الكبير', resetTitle: 'بدء تجربة جديدة؟', resetBody: 'استعادة 12,000 رصيد تجريبي ومسح اللفات المجانية وسجل الجولات.', resetYes: 'بدء من جديد', cancel: 'إلغاء', target: 'العائد المستهدف', version: 'إصدار الحسابات', limits: 'الحد الأقصى للمضاعف 100×، و24 تساقطًا لكل لفة، وعائد 1,000 ضعف الرهان لكل لفة. تُحتسب الحدود ضمن النموذج.', rulesIntro: 'تدفع 8 رموز متطابقة أو أكثر في أي مكان. لا يشترط التجاور. تختفي الرموز الرابحة وتُستبدل حتى تتوقف الأرباح.', rulesBonus: '4 رموز Scatter أو أكثر تمنح 15 لفة مجانية. 3 رموز أثناء اللفات المجانية تضيف 5 لفات. تبقى قيمة الرهان ثابتة.', rulesMulti: 'تُقرّب مكافأة كل رمز إلى 0.01. تُجمع كرات المضاعفات وتُطبق على مجموع أرباح اللفة. في اللفات المجانية تُضاف مضاعفات اللفات الرابحة إلى المجموع المستمر، بحد أقصى 100×.', rulesDemo: 'رصيد تجريبي محلي غير مرتبط برصيد التطبيق. 99% هدف للعائد على المدى الطويل وليس احتمال الفوز. نتائج المحاكاة في تقرير المشروع.', count: 'العدد', payout: 'العائد / الرهان', net: 'الصافي', copied: 'تمت استعادة الجولة', loading: 'جارٍ الاتصال بالمحفظة التجريبية…', connectFail: 'تعذر الاتصال. أعد المحاولة.', noMoney: 'الرصيد غير كافٍ. يمكنك إعادة التجربة من الإعدادات.', resume: 'متابعة الجولة', ruleTitle: 'قواعد الرعد', historyTitle: 'سجل الجولات', settingsTitle: 'إعدادات اللعبة', on: 'تشغيل', off: 'إيقاف', bonus: 'لفة مجانية', network: 'تم تحديث حالة اللعبة', screen: 'ملء الشاشة', close: 'إغلاق', settled: 'تمت التسوية', normal: 'لفة عادية', replay: 'انتهت المعاينة', tryAgain: 'إعادة الاتصال' },
};
const cp = (key: keyof typeof copy.zh) => copy[locale][key];
const autoCopy = {
  zh: { title: '自动旋转', start: '开始自动旋转', stop: '停止自动旋转', stopped: '自动旋转已停止', count: '付费旋转次数', note: '免费转不占次数，会自动衔接。点击 AUTO 可随时停止；当前一轮正常结算。切到后台或连接异常会停止。', remaining: '剩余', paid: '次付费旋转', finishing: '完成免费旋转后停止', cost: '每轮投入', status: 'AUTO', wait: '当前一轮结束后停止' },
  en: { title: 'AUTO PLAY', start: 'START AUTO PLAY', stop: 'STOP AUTO PLAY', stopped: 'Auto play stopped', count: 'PAID SPINS', note: 'Free spins do not use the count and play automatically. Tap AUTO to stop after the current round. Switching away or connection errors stops auto play.', remaining: 'REMAINING', paid: 'PAID SPINS', finishing: 'Finishing free spins', cost: 'BET PER SPIN', status: 'AUTO', wait: 'Stopping after this round' },
  ar: { title: 'التدوير التلقائي', start: 'بدء التدوير التلقائي', stop: 'إيقاف التدوير التلقائي', stopped: 'توقف التدوير التلقائي', count: 'عدد اللفات المدفوعة', note: 'اللفات المجانية لا تنقص العدد وتستمر تلقائيًا. اضغط AUTO للإيقاف بعد الجولة الحالية. يتوقف عند مغادرة الصفحة أو انقطاع الاتصال.', remaining: 'المتبقي', paid: 'لفات مدفوعة', finishing: 'إكمال اللفات المجانية', cost: 'قيمة كل لفة', status: 'AUTO', wait: 'سيتوقف بعد هذه الجولة' },
};
const soundCopy = {
  zh: { master: '全部声音', music: '背景音乐', sfx: '游戏音效', musicVolume: '音乐音量', sfxVolume: '音效音量', test: '试听中奖音效', start: '点击开启音乐', playing: '音乐播放中', muted: '声音已关闭', musicOff: '音乐已关闭', resume: '点击恢复音乐', unavailable: '声音暂不可用', hint: '音乐与音效可独立调节。右上角喇叭控制全部声音。', listen: '试听', enabled: '声音已开启' },
  en: { master: 'ALL SOUND', music: 'BACKGROUND MUSIC', sfx: 'GAME EFFECTS', musicVolume: 'MUSIC VOLUME', sfxVolume: 'EFFECT VOLUME', test: 'PREVIEW WIN SOUND', start: 'TAP FOR MUSIC', playing: 'MUSIC PLAYING', muted: 'SOUND OFF', musicOff: 'MUSIC OFF', resume: 'RESUME MUSIC', unavailable: 'SOUND UNAVAILABLE', hint: 'Set music and effects separately. The speaker icon controls all sound.', listen: 'PREVIEW', enabled: 'Sound enabled' },
  ar: { master: 'جميع الأصوات', music: 'موسيقى الخلفية', sfx: 'مؤثرات اللعبة', musicVolume: 'مستوى الموسيقى', sfxVolume: 'مستوى المؤثرات', test: 'تجربة صوت الفوز', start: 'اضغط لتشغيل الموسيقى', playing: 'الموسيقى تعمل', muted: 'الصوت مغلق', musicOff: 'الموسيقى مغلقة', resume: 'استئناف الموسيقى', unavailable: 'الصوت غير متاح', hint: 'اضبط الموسيقى والمؤثرات بشكل منفصل. رمز السماعة يتحكم بجميع الأصوات.', listen: 'تجربة', enabled: 'تم تشغيل الصوت' },
};
const sc = (key: keyof typeof soundCopy.zh) => soundCopy[locale][key];
const ac = (key: keyof typeof autoCopy.zh) => autoCopy[locale][key];
const number = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const newRequestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
const ico = (name: string) => {
  const paths: Record<string, string> = {
    bolt: '<path d="m14 2-9 12h7l-2 8 9-12h-7z"/>',
    sound: '<path d="m11 5-6 4H2v6h3l6 4z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    mute: '<path d="m11 5-6 4H2v6h3l6 4zM16 9l6 6m0-6-6 6"/>',
    spin: '<path d="M19.8 7.8A8.2 8.2 0 1 0 20 16M20 2.5v6.3h-6.3"/>',
    auto: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/><path d="m10 8 6 4-6 4z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/>',
    book: '<path d="M12 5c-3-2-7-2-10 0v15c3-2 7-2 10 0 3-2 7-2 10 0V5c-3-2-7-2-10 0Zm0 0v15"/>',
    history: '<path d="M3 10a9 9 0 1 1 2 8M3 3v7h7M12 7v5l3 2"/>',
    settings: '<path d="M5 4v16m7-16v16m7-16v16M2 8h6m1 8h6m1-9h6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.bolt}</svg>`;
};
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="world" aria-hidden="true"><div class="world-glow"></div><div class="world-stars"></div></div>
  <main class="experience">
    <aside class="editorial"><div class="collection-label"><span></span>THE CELESTIAL COLLECTION</div><div class="edition-number">01 / THUNDER</div><h1>THUNDER<br><em>THRONE</em></h1><p class="editorial-subtitle"></p><div class="editorial-line"></div><p class="editorial-detail">6 × 5 <span>·</span> TUMBLE <span>·</span> MULTIPLIERS</p><div class="edition-seal">${ico('bolt')}<span>PLAY THE<br>EXTRAORDINARY</span></div><div class="desktop-demo">DEMO EXPERIENCE <span>NO CASH VALUE</span></div></aside>
    <section class="game-shell" aria-label="Thunder Throne">
      <header class="hero"><div class="hero-art" role="img" aria-label="THUNDER THRONE"></div><div class="hero-shade"></div><div class="hero-atmosphere" aria-hidden="true"><div class="hero-clouds"></div><div class="hero-aura"></div><div class="hero-sparks"></div></div><svg class="hero-energy" viewBox="0 0 941 456" aria-hidden="true"><path d="M771 0 795 63 783 90 810 135 792 161 818 206 804 231 838 291 826 321 862 384 852 418 889 456"/><path d="m794 92-34 22 15 21-47 19m83 51 35-27-6-25 25-16m-19 195-34 18 9 22-29 17"/></svg><div class="topbar"><button class="round-icon info-button" data-action="rules" aria-label="游戏规则">${ico('book')}</button><div class="topbar-right"><button class="language-pill" data-action="language">中文</button><button class="round-icon sound-button" data-action="sound" aria-label="声音">${ico('sound')}</button></div></div><div class="hero-bottom"><span class="demo-badge"><i></i><span data-i18n="demo"></span></span><button class="audio-status-badge" data-action="audio-start"><span class="audio-equalizer" aria-hidden="true"><i></i><i></i><i></i></span><span class="audio-status-text"></span></button></div></header>
      <div class="play-area">
        <div class="feature-bar"><span class="feature-status">${ico('bolt')}<span id="feature-status-text">THUNDER AWAITS</span></span><span id="feature-value">1×</span></div>
        <div class="board-surround"><i class="corner top-left"></i><i class="corner top-right"></i><i class="corner bottom-left"></i><i class="corner bottom-right"></i><div class="board" id="board" aria-label="6列5行游戏盘面" dir="ltr"></div><div class="board-flash"></div><div class="cascade-tag" aria-hidden="true"></div></div>
        <div class="round-message" role="status" aria-live="polite"><span id="round-message"></span></div>
        <div class="control-deck"><div class="deck-flames" aria-hidden="true"><i></i><i></i></div><div class="stats"><div class="stat"><span data-i18n="balance"></span><strong id="balance" dir="ltr">12,000</strong></div><div class="stat stat-bet"><span data-i18n="bet"></span><button id="bet-value" data-action="bet" dir="ltr">100</button></div><div class="stat"><span data-i18n="win"></span><strong id="win-value" dir="ltr">0</strong></div></div>
        <div class="spin-dock"><button class="dock-icon turbo-button" data-action="turbo" aria-label="极速模式">${ico('bolt')}<span>QUICK</span></button><button class="stake-button" data-action="minus" aria-label="减少投入">−</button><button class="spin-button" id="spin" aria-label="旋转" disabled><span class="spin-halo"></span><span class="spin-ring" aria-hidden="true"></span><span class="spin-ornament" aria-hidden="true"></span><span class="spin-center">${ico('spin')}</span><span class="spin-label" data-i18n="spin"></span></button><button class="stake-button" data-action="plus" aria-label="增加投入">+</button><button class="dock-icon auto-button" data-action="auto" aria-label="自动旋转"><span class="auto-icon">${ico('auto')}</span><span class="auto-label">AUTO</span></button></div>
        <div class="auto-status" aria-live="polite" hidden></div><nav class="bottom-nav"><button data-action="rules">${ico('book')}<span data-i18n="rules"></span></button><button data-action="history">${ico('history')}<span data-i18n="history"></span></button><button data-action="settings">${ico('settings')}<span data-i18n="settings"></span></button></nav>
        <footer class="game-footer"><span id="rtp-label"></span><span>DEMO CREDITS · NO CASH VALUE</span></footer></div>
      </div>
      <div class="celebration" hidden><div class="celebration-rays"></div><div class="celebration-card"><div class="celebration-emblem">${ico('bolt')}</div><span class="celebration-kicker"></span><h2 class="celebration-title"></h2><strong class="celebration-value" dir="ltr"></strong><p class="celebration-detail"></p><button class="gold-button celebration-close"></button><button class="celebration-auto-stop" hidden></button></div></div>
      <div class="toast" role="status"></div>
    </section>
    <aside class="right-note"><span class="vertical-caption">CRAFTED IN LIGHTNING · 2026</span><span class="right-star">✧</span></aside>
  </main>
  <dialog id="panel"><div class="panel-header"><h2 id="panel-title"></h2><button class="panel-close" aria-label="关闭">${ico('close')}</button></div><div id="panel-content"></div></dialog>
`;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const shell = $('.game-shell');
const board = $('#board');
const spinButton = $<HTMLButtonElement>('#spin');
const dialog = $<HTMLDialogElement>('#panel');
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, reducedMotion.matches ? Math.min(ms, 90) : turbo ? ms * .42 : ms));
const sprites: Record<string, [number, number]> = { sapphire: [43, 483], emerald: [188, 483], ruby: [333, 483], amethyst: [477, 483], pearl: [622, 483], amber: [768, 483], crown: [43, 630], chalice: [477, 630], scatter: [333, 776] };
const cells: HTMLDivElement[] = [];
for (let i = 0; i < 30; i++) {
  const cell = document.createElement('div'); cell.className = 'cell'; cell.style.setProperty('--column', String(i % 6)); cell.style.setProperty('--row', String(Math.floor(i / 6)));
  board.appendChild(cell); cells.push(cell);
}
function symbolMarkup(id: string, multiplier?: number) {
  if (id === 'multiplier') return `<div class="multiplier-orb"><span>${multiplier ?? 2}<small>×</small></span></div>`;
  const [x, y] = sprites[id] ?? sprites.sapphire;
  return `<div class="symbol-art" style="background-position:${x / (941 - 130) * 100}% ${y / (1672 - 130) * 100}%"></div>`;
}
const motion = new GameMotion(shell, board, symbolMarkup, () => reducedMotion.matches, () => turbo);
const character = new HeroCharacter($('.hero'), () => reducedMotion.matches);
function renderBoard(value: Cell[], falling = false, previous?: Cell[]) {
  displayedBoard = value;
  value.forEach((symbol, i) => {
    const cell = cells[i];
    cell.className = `cell symbol-${symbol.symbol}`;
    cell.dataset.symbol = symbol.symbol;
    cell.setAttribute('aria-label', `${Math.floor(i / 6) + 1},${i % 6 + 1}: ${SYMBOLS.find(s => s.id === symbol.symbol)?.name ?? symbol.symbol}${symbol.multiplier ? ` ${symbol.multiplier}×` : ''}`);
    cell.innerHTML = symbolMarkup(symbol.symbol, symbol.multiplier);
    if (falling && !reducedMotion.matches) {
      const old = previous?.findIndex(c => c.id === symbol.id) ?? -1;
      const distance = old >= 0 ? Math.floor(i / 6) - Math.floor(old / 6) : Math.floor(i / 6) + 2;
      if (distance > 0 || !previous) {
        const delay = (i % 6) * (turbo ? 12 : 26);
        cell.animate([{ transform: `translateY(-${Math.max(distance, 1) * 100}%)`, opacity: 0 }, { transform: 'translateY(5%)', opacity: 1, offset: .84 }, { transform: 'translateY(0)', opacity: 1 }], { duration: turbo ? 220 : 430, delay, easing: 'cubic-bezier(.2,.65,.3,1)' });
      }
    }
  });
}
function message(text: string, positive = false) { $('#round-message').textContent = text; $('.round-message').classList.toggle('positive', positive); }
function toast(text: string) { const el = $('.toast'); el.textContent = text; el.classList.add('visible'); setTimeout(() => el.classList.remove('visible'), 3300); }
function updateAudioUI() {
  const state = audio.audioState;
  const playing = audio.getStatus().music.playing;
  const statusText = !audio.enabled ? sc('muted') : !audio.musicEnabled || audio.musicVolume === 0 ? sc('musicOff') : state === 'unavailable' ? sc('unavailable') : playing ? sc('playing') : state === 'paused' ? sc('resume') : sc('start');
  $('.audio-status-text').textContent = statusText;
  $('.audio-status-badge').setAttribute('aria-label', statusText);
  $('.audio-status-badge').classList.toggle('playing', playing);
  $('.sound-button').innerHTML = ico(audio.enabled ? 'sound' : 'mute');
  $('.sound-button').setAttribute('aria-label', tr(audio.enabled ? 'mute' : 'unmute'));
  $('.sound-button').setAttribute('aria-pressed', String(audio.enabled));
}
async function unlockSound() { await audio.unlock(); updateAudioUI(); }
function updateUI() {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n as TranslationKey); });
  $('.editorial-subtitle').textContent = cp('subtitle');
  $('.language-pill').textContent = locale === 'zh' ? '中文' : locale === 'ar' ? 'عربي' : 'EN';
  updateAudioUI();
  $('.info-button').setAttribute('aria-label', tr('rules'));
  $('.turbo-button').setAttribute('aria-label', tr('turbo'));
  $('.turbo-button').setAttribute('aria-pressed', String(turbo));
  $('.turbo-button').classList.toggle('active', turbo);
  $('[data-action="minus"]').setAttribute('aria-label', tr('decreaseBet'));
  $('[data-action="plus"]').setAttribute('aria-label', tr('increaseBet'));
  $('.panel-close').setAttribute('aria-label', tr('close'));
  const running = autoplay?.active ?? false;
  const autoButton = $<HTMLButtonElement>('.auto-button');
  autoButton.classList.toggle('active', running);
  autoButton.setAttribute('aria-label', running ? ac('stop') : ac('title'));
  autoButton.setAttribute('aria-pressed', String(running));
  autoButton.disabled = !running && (busy || previewing || !session || !!session.pendingRound);
  $('.auto-icon').innerHTML = ico(running ? 'stop' : 'auto');
  $('.auto-label').textContent = running ? String(autoplay.remaining) : 'AUTO';
  $('.auto-status').hidden = !running;
  $('.auto-status').textContent = running ? autoplay.remaining > 0 ? `AUTO · ${ac('remaining')} ${autoplay.remaining} ${ac('paid')}` : ac('finishing') : '';
  $('.celebration-auto-stop').hidden = !running;
  $('.celebration-auto-stop').textContent = ac('stop');
  board.setAttribute('aria-busy', String(busy));
  board.setAttribute('aria-label', locale === 'zh' ? '6列5行游戏盘面' : locale === 'ar' ? 'لوحة اللعب: 6 أعمدة و5 صفوف' : 'Game board: 6 columns and 5 rows');
  $('#balance').textContent = number(displayBalance);
  $('#bet-value').textContent = number(session?.lockedBet ?? bet);
  $('#win-value').textContent = number(lastWin);
  $('#rtp-label').textContent = `${cp('target')} 99%`;
  const free = (session?.freeSpins ?? 0) > 0;
  shell.classList.toggle('bonus-mode', free || previewing);
  $('#feature-status-text').textContent = free ? `${tr('freeSpins')} · ${session!.freeSpins}` : 'THUNDER AWAITS';
  $('#feature-value').textContent = free ? `${Math.max(1, session!.freeMultiplier)}×` : '8+ TO WIN';
  $('.spin-label').textContent = busy ? tr('spinning') : session?.pendingRound ? cp('resume') : free ? `${tr('spin')} · ${session!.freeSpins}` : tr('spin');
  spinButton.setAttribute('aria-label', busy ? tr('spinning') : session?.pendingRound ? cp('resume') : tr('spin'));
  spinButton.disabled = busy || !session || previewing || running;
  for (const el of document.querySelectorAll<HTMLButtonElement>('[data-action="minus"], [data-action="plus"], [data-action="bet"]')) el.disabled = busy || free || running || !session;
  if (session) {
    const current = session.betChoices.indexOf(bet);
    $<HTMLButtonElement>('[data-action="minus"]').disabled ||= current <= 0;
    $<HTMLButtonElement>('[data-action="plus"]').disabled ||= current >= session.betChoices.length - 1;
  }
}
class ApiError extends Error { constructor(public code: string, message: string) { super(message); } }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new ApiError(result.error?.code ?? 'HTTP_ERROR', result.error?.message ?? 'Request failed');
    return result as T;
  } finally { clearTimeout(timeout); }
}
async function connect() {
  message(cp('loading'));
  try { session = await api<Session>('session'); displayBalance = session.balance; bet = session.lockedBet ?? (session.betChoices.includes(bet) ? bet : session.betChoices[0]); updateUI(); message(session.pendingRound ? cp('copied') : cp('ready')); }
  catch { message(cp('connectFail')); $('#round-message').innerHTML = `${cp('connectFail')} <button class="inline-retry">${cp('tryAgain')}</button>`; $('.inline-retry')?.addEventListener('click', () => void connect()); }
}
async function spin(fromAuto = false): Promise<{ isFreeSpin: boolean } | null> {
  if (busy || !session || previewing || (!fromAuto && autoplay.active)) return null;
  if (!session.pendingRound && !session.freeSpins && session.balance < bet) { toast(cp('noMoney')); autoplay.stop(); return null; }
  busy = true; roundWasAuto = fromAuto; lastWin = 0; updateUI(); shell.classList.add('is-spinning'); motion.startReels(); message(tr('spinning'));
  try {
    await unlockSound();
    if (fromAuto && (!autoplay.active || document.hidden)) return null;
    audio.spin(); character.react('spin');
    let round: Round;
    let finalSession: Session;
    if (session.pendingRound) { round = session.pendingRound; finalSession = session; }
    else {
      const requestId = retryRequestId ?? newRequestId();
      const requestBet = retryRequestId ? retryBet : session.lockedBet ?? bet;
      retryRequestId = requestId; retryBet = requestBet;
      const [response] = await Promise.all([api<SpinResponse>('spin', { requestId, bet: requestBet, expectedVersion: session.stateVersion }), wait(700)]);
      round = response.round; finalSession = response.session; retryRequestId = null;
    }
    if (round.epoch !== finalSession.epoch) {
      session = finalSession; displayBalance = session.balance; lastWin = 0; bet = session.lockedBet ?? bet; renderBoard(INITIAL_BOARD); message(cp('network')); autoplay.stop(); return null;
    }
    displayBalance = round.balanceBefore - (round.isFreeSpin ? 0 : round.bet); updateUI();
    await playRound(round);
    session = finalSession; displayBalance = session.balance; lastWin = round.win;
    try { session = (await api<{ session: Session }>('round/ack', { roundId: round.id })).session; } catch { toast(cp('copied')); autoplay.stop(); }
    displayBalance = session.balance; bet = session.lockedBet ?? bet;
    if (round.epoch !== session.epoch || session.stateVersion !== finalSession.stateVersion) { lastWin = 0; renderBoard(INITIAL_BOARD); message(cp('network')); autoplay.stop(); return null; }
    updateUI();
    if (round.engine.freeSpinsAwarded > 0) await showBonus(round.engine.freeSpinsAwarded);
    if (round.isFreeSpin && session.freeSpins === 0) toast(cp('bonusOver'));
    return { isFreeSpin: round.isFreeSpin };
  } catch (error) {
    autoplay.stop();
    if (error instanceof ApiError && !['INTERNAL_ERROR', 'HTTP_ERROR'].includes(error.code)) retryRequestId = null;
    try { session = await api<Session>('session'); displayBalance = session.balance; bet = session.lockedBet ?? bet; if (session.pendingRound) { retryRequestId = null; message(cp('copied')); } else message(error instanceof ApiError && /INSUFFICIENT/.test(error.code) ? cp('noMoney') : error instanceof ApiError && error.code === 'STATE_CHANGED' ? cp('network') : cp('connectFail')); }
    catch { message(cp('connectFail')); }
    return null;
  } finally { motion.cancelReels(); busy = false; roundWasAuto = false; shell.classList.remove('is-spinning'); updateUI(); }
}
async function playRound(round: Round) {
  const result = round.engine;
  renderBoard(result.initialBoard);
  await motion.landReels(result.initialBoard);
  shell.classList.remove('is-spinning'); audio.land(); await wait(220);
  let cumulative = 0;
  for (const step of result.steps) {
    renderBoard(step.board);
    for (const index of step.winningIndices) cells[index].classList.add('winning');
    cumulative += step.baseWin / 100;
    lastWin = cumulative; void motion.countUp($('#win-value'), lastWin, number, turbo ? 220 : 500);
    const tag = $('.cascade-tag'); tag.textContent = `${cp('cascade')} ${step.index + 1}  +${number(step.baseWin / 100)}`; tag.classList.add('show');
    message(`${cp('cascade')} ${step.index + 1} · ${step.wins.map(w => `${w.count} × ${symbolName(w.symbol)}`).join(' + ')}`, true);
    if (round.isFreeSpin || round.win > round.bet) audio.win('small'); else audio.land();
    motion.hit(step.winningIndices, Math.min(2.5, 1 + step.index * .3));
    await wait(620);
    step.winningIndices.forEach(i => cells[i].classList.add('vanishing'));
    motion.hit(step.winningIndices, 1.3);
    await wait(260);
    const next = result.steps[step.index + 1]?.board ?? result.endBoard;
    renderBoard(next, true, step.board); audio.land(); tag.classList.remove('show'); await wait(510);
  }
  renderBoard(result.endBoard);
  if (result.multiplier > 1 && result.baseWin > 0) {
    cells.forEach((cell, i) => { if (result.endBoard[i].symbol === 'multiplier') cell.classList.add('winning'); });
    $('#feature-value').textContent = `${result.multiplier}×`;
    $('.feature-bar').classList.add('charged'); audio.scatter(); flash(); motion.lightning(1.7);
    message(result.winCapReached ? `${cp('paid')} ${number(round.win)} · MAX ${GAME_CONFIG.maxWinMultiple}×` : `${number(result.baseWin / 100)} × ${result.multiplier} = ${number(round.win)}`, true);
    await wait(850); $('.feature-bar').classList.remove('charged');
  }
  lastWin = round.win;
  await motion.countUp($('#win-value'), lastWin, number, turbo ? 220 : 560);
  const net = round.win - (round.isFreeSpin ? 0 : round.bet);
  message(round.win > 0 ? `${cp('paid')} ${number(round.win)} · ${cp('net')} ${net > 0 ? '+' : ''}${number(net)}` : cp('empty'), net > 0);
  if (net > 0) { if (round.win < round.bet * 10) { character.react('win'); audio.win('small'); } motion.hit(result.steps.flatMap(step => step.winningIndices), round.win >= round.bet * 10 ? 2.5 : 1.2); }
  if (round.win >= round.bet * 10) await showWin(round.win, round.bet, false);
}
const arabicSymbols: Record<SymbolId, string> = { ruby: 'ياقوت', emerald: 'زمرد', sapphire: 'زفير', amethyst: 'جمشت', amber: 'كهرمان', crown: 'تاج', chalice: 'كأس', pearl: 'لؤلؤة', scatter: 'سكاتر', multiplier: 'مضاعف' };
function symbolName(id: SymbolId) { const symbol = SYMBOLS.find(s => s.id === id)!; return locale === 'zh' ? symbol.label : locale === 'ar' ? arabicSymbols[id] : symbol.name; }
function flash() { const el = $('.board-flash'); el.classList.remove('active'); void el.offsetWidth; el.classList.add('active'); }
let celebrationResolver: (() => void) | null = null;
let celebrationTimer: ReturnType<typeof setTimeout> | null = null;
function closeCelebration() {
  if (celebrationTimer) clearTimeout(celebrationTimer);
  celebrationTimer = null; motion.stopCelebration();
  $('.celebration').hidden = true; celebrationResolver?.(); celebrationResolver = null;
}
function celebration(title: string, value: string, detail: string, button: string, kicker: string): Promise<void> {
  $('.celebration-title').textContent = title; $('.celebration-value').textContent = value; $('.celebration-detail').textContent = detail; $('.celebration-kicker').textContent = kicker; $('.celebration-close').textContent = button;
  $('.celebration-auto-stop').hidden = !autoplay.active; $('.celebration-auto-stop').textContent = ac('stop');
  $('.celebration').hidden = false; $('.celebration-close').focus();
  if (roundWasAuto) celebrationTimer = setTimeout(closeCelebration, turbo ? 2100 : 3400);
  return new Promise(resolve => { celebrationResolver = resolve; });
}
async function showWin(win: number, stake: number, preview: boolean) {
  character.react('big'); audio.win('big'); motion.lightning(2); motion.startCelebration(); $('.celebration').classList.add('is-mega');
  const done = celebration(win >= stake * 50 ? 'MEGA WIN' : 'BIG WIN', '0', `${number(win / stake)}× ${tr('bet')}`, tr('continue'), preview ? cp('previewNote') : 'THUNDER THRONE');
  void motion.countUp($('.celebration-value'), win, number, turbo ? 1500 : 2500);
  await done; $('.celebration-value').textContent = number(win); $('.celebration').classList.remove('is-mega');
}
async function showBonus(count: number) {
  character.react('bonus'); audio.scatter(); flash(); motion.lightning(1.8); motion.startCelebration();
  await celebration(cp('feature'), String(count), cp('bonusAward'), cp('enterBonus'), 'FREE SPINS');
}
function stopAuto(notify = false) {
  const active = autoplay.active; autoplay.stop();
  if (active && notify) toast(busy ? ac('wait') : ac('stopped'));
}
function openPanel(title: string, content: string) { stopAuto(); $('#panel-title').textContent = title; $('#panel-content').innerHTML = content; if (!dialog.open) dialog.showModal(); }
function showAuto() {
  if (autoplay.active) { stopAuto(true); return; }
  if (busy || previewing || !session || session.pendingRound) return;
  let selected = 10;
  openPanel(ac('title'), `<div class="auto-emblem">${ico('auto')}</div><p class="auto-intro">${ac('count')}</p><div class="auto-choices">${AUTO_PLAY_COUNTS.map(count => `<button class="auto-choice ${count === selected ? 'selected' : ''}" data-count="${count}" aria-pressed="${count === selected}">${count}</button>`).join('')}</div><p class="auto-bet">${ac('cost')} <strong dir="ltr">${number(session.lockedBet ?? bet)}</strong></p><p class="subtle">${ac('note')}</p><button class="gold-button auto-start">${ac('start')}</button>`);
  dialog.querySelectorAll<HTMLButtonElement>('.auto-choice').forEach(button => button.addEventListener('click', () => {
    selected = Number(button.dataset.count);
    dialog.querySelectorAll<HTMLButtonElement>('.auto-choice').forEach(option => { const isSelected = Number(option.dataset.count) === selected; option.classList.toggle('selected', isSelected); option.setAttribute('aria-pressed', String(isSelected)); });
  }));
  $('.auto-start').addEventListener('click', () => { dialog.close(); void autoplay.start(selected).catch(() => { stopAuto(); toast(cp('connectFail')); }); });
}
function showRules() {
  const precise = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 5 }).format(value);
  const rows = SYMBOLS.filter(s => s.payouts[0] > 0).map(s => `<tr><td><span class="pay-symbol" style="--symbol-color:${s.color}">◆</span>${symbolName(s.id)}</td>${s.payouts.map(p => `<td dir="ltr">${precise(p * GAME_CONFIG.paytableScale / 10000)}×</td>`).join('')}</tr>`).join('');
  openPanel(cp('ruleTitle'), `<div class="rule-intro"><span class="rule-crest">${ico('bolt')}</span><strong>6 × 5</strong><span>PAY ANYWHERE</span></div><p>${cp('rulesIntro')}</p><table class="paytable"><thead><tr><th>${cp('count')}</th><th dir="ltr">8–9</th><th dir="ltr">10–11</th><th dir="ltr">12+</th></tr></thead><tbody>${rows}</tbody></table><div class="rule-section"><h3>SCATTER · FREE SPINS</h3><p>${cp('rulesBonus')}</p></div><div class="rule-section"><h3>MULTIPLIER</h3><p>${cp('rulesMulti')}</p></div><p class="subtle">${cp('limits')}</p><div class="math-note"><strong>${cp('target')} 99%</strong><p>${cp('rulesDemo')}</p><small>${cp('version')} · ${GAME_CONFIG.mathVersion}</small></div>`);
}
async function showHistory() {
  openPanel(cp('historyTitle'), `<p class="subtle">${tr('loading')}</p>`);
  try {
    const { rounds } = await api<{ rounds: Round[] }>('history');
    if (!dialog.open) return;
    $('#panel-content').innerHTML = rounds.length ? `<div class="history-list">${rounds.map(r => `<article class="history-item"><div><strong>${r.isFreeSpin ? cp('bonus') : cp('normal')}</strong><small>${new Date(r.createdAt).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${r.id.slice(-6)}</small></div><div class="history-amount"><strong class="${r.win > (r.isFreeSpin ? 0 : r.bet) ? 'profit' : ''}" dir="ltr">${number(r.win)}</strong><small>${tr('bet')} <bdi>${number(r.bet)}</bdi></small></div></article>`).join('')}</div>` : `<div class="empty-state">${ico('history')}<p>${tr('noHistory')}</p></div>`;
  } catch { $('#panel-content').innerHTML = `<p>${cp('connectFail')}</p>`; }
}
function showSettings() {
  const soundSwitch = (key: 'sound' | 'music' | 'sfx', label: string, value: boolean) => `<div class="settings-row"><span>${label}</span><button class="toggle ${value ? 'on' : ''}" data-setting="${key}" role="switch" aria-checked="${value}" aria-label="${label}"></button></div>`;
  const volumeSlider = (key: 'music' | 'sfx', label: string, value: number) => `<div class="audio-volume"><label for="${key}-volume">${label}<output id="${key}-volume-value" dir="ltr">${Math.round(value * 100)}%</output></label><input id="${key}-volume" data-volume="${key}" type="range" min="0" max="100" step="5" value="${Math.round(value * 100)}" aria-label="${label}" /></div>`;
  openPanel(cp('settingsTitle'), `<div class="audio-settings">${soundSwitch('sound', sc('master'), audio.enabled)}${soundSwitch('music', sc('music'), audio.musicEnabled)}${volumeSlider('music', sc('musicVolume'), audio.musicVolume)}${soundSwitch('sfx', sc('sfx'), audio.sfxEnabled)}${volumeSlider('sfx', sc('sfxVolume'), audio.sfxVolume)}<button class="audio-test-button" data-setting="test-sound">${ico('sound')}${sc('test')}</button><p class="subtle audio-hint">${sc('hint')}</p></div><div class="settings-row"><span>${tr('turbo')}</span><button class="toggle ${turbo ? 'on' : ''}" data-setting="turbo" role="switch" aria-checked="${turbo}" aria-label="${tr('turbo')}"></button></div><div class="settings-row"><label for="locale-choice">${tr('language')}</label><select id="locale-choice"><option value="zh" ${locale === 'zh' ? 'selected' : ''}>中文</option><option value="en" ${locale === 'en' ? 'selected' : ''}>English</option><option value="ar" ${locale === 'ar' ? 'selected' : ''}>العربية</option></select></div><div class="setting-section"><h3>${cp('preview')}</h3><div class="preview-actions"><button data-preview="bonus">${ico('bolt')}${cp('bonusPreview')}</button><button data-preview="mega">${ico('bolt')}${cp('megaPreview')}</button></div><p class="subtle">${cp('previewNote')}</p></div><button class="reset-button" data-setting="reset">${tr('reset')}</button><p class="subtle">${cp('rulesDemo')}</p>`);
  $('#locale-choice').addEventListener('change', e => { locale = (e.target as HTMLSelectElement).value as Locale; savePref('tt-language', locale); updateUI(); showSettings(); if (!busy) message(cp('ready')); });
  dialog.querySelectorAll<HTMLInputElement>('[data-volume]').forEach(el => el.addEventListener('input', () => {
    const key = el.dataset.volume as 'music' | 'sfx'; const value = Number(el.value) / 100;
    if (key === 'music') audio.setMusicVolume(value); else audio.setSfxVolume(value);
    savePref(`tt-${key}-volume`, String(value)); $(`#${key}-volume-value`).textContent = `${el.value}%`; updateAudioUI();
  }));
  dialog.querySelectorAll<HTMLButtonElement>('[data-setting]').forEach(el => el.addEventListener('click', async () => {
    const setting = el.dataset.setting;
    if (setting === 'sound' || setting === 'music' || setting === 'sfx') {
      if (setting === 'sound') { audio.setEnabled(!audio.enabled); savePref('tt-sound', String(audio.enabled)); }
      if (setting === 'music') { audio.setMusicEnabled(!audio.musicEnabled); savePref('tt-music', String(audio.musicEnabled)); }
      if (setting === 'sfx') { audio.setSfxEnabled(!audio.sfxEnabled); savePref('tt-sfx', String(audio.sfxEnabled)); }
      await unlockSound(); updateUI(); if (dialog.open) showSettings();
    }
    if (setting === 'test-sound') {
      audio.setEnabled(true); audio.setSfxEnabled(true); if (!audio.sfxVolume) audio.setSfxVolume(.85);
      savePref('tt-sound', 'true'); savePref('tt-sfx', 'true'); savePref('tt-sfx-volume', String(audio.sfxVolume));
      await unlockSound(); audio.win('big'); updateUI(); if (dialog.open) showSettings();
    }
    if (setting === 'turbo') { turbo = !turbo; savePref('tt-turbo', String(turbo)); updateUI(); showSettings(); }
    if (setting === 'reset') showReset();
  }));
  dialog.querySelectorAll<HTMLButtonElement>('[data-preview]').forEach(el => el.addEventListener('click', () => { dialog.close(); void preview(el.dataset.preview as 'bonus' | 'mega'); }));
}
async function preview(kind: 'bonus' | 'mega') {
  if (busy || previewing) return;
  previewing = true; updateUI(); await unlockSound(); const original = displayedBoard;
  if (kind === 'mega') await showWin(25000, 100, true);
  else {
    const showcase = INITIAL_BOARD.map((c, i) => ({ ...c, id: `preview-${i}` }));
    for (const index of [0, 1, 8, 10, 17, 19, 21, 27]) showcase[index] = { id: `preview-${index}`, symbol: 'emerald' };
    showcase[16] = { id: 'preview-16', symbol: 'multiplier', multiplier: 5 }; showcase[29] = { id: 'preview-29', symbol: 'multiplier', multiplier: 10 };
    renderBoard(showcase, true); message(cp('previewNote')); $('#feature-status-text').textContent = 'FREE SPINS · 7'; $('#feature-value').textContent = '40×';
    await wait(500); [0, 1, 8, 10, 17, 19, 21, 27].forEach(i => cells[i].classList.add('winning')); character.react('bonus'); audio.scatter(); motion.hit([0, 1, 8, 10, 17, 19, 21, 27], 2); motion.lightning(1.5); motion.startCelebration();
    await celebration('FREE SPINS', '15', cp('previewNote'), tr('continue'), cp('feature'));
  }
  renderBoard(original); previewing = false; updateUI(); message(cp('ready'));
}
function showReset() {
  openPanel(cp('resetTitle'), `<p>${cp('resetBody')}</p><div class="confirm-actions"><button class="quiet-button reset-cancel">${cp('cancel')}</button><button class="gold-button reset-confirm">${cp('resetYes')}</button></div>`);
  $('.reset-cancel').addEventListener('click', () => showSettings());
  $('.reset-confirm').addEventListener('click', async () => {
    if (busy) { dialog.close(); return; }
    busy = true; updateUI();
    $<HTMLButtonElement>('.reset-confirm').disabled = true;
    try { session = (await api<{ session: Session }>('reset', { requestId: newRequestId() })).session; displayBalance = session.balance; lastWin = 0; retryRequestId = null; bet = 100; renderBoard(INITIAL_BOARD); updateUI(); message(cp('ready')); dialog.close(); }
    catch { toast(cp('connectFail')); const confirm = document.querySelector<HTMLButtonElement>('.reset-confirm'); if (confirm) confirm.disabled = false; }
    finally { busy = false; updateUI(); }
  });
}
function showBets() {
  if (!session || busy || session.freeSpins || autoplay.active) return;
  openPanel(tr('bet'), `<div class="bet-choices">${session.betChoices.map(value => `<button class="bet-choice ${value === bet ? 'selected' : ''}" data-value="${value}" dir="ltr">${number(value)} ${ico(value === bet ? 'check' : 'chevron')}</button>`).join('')}</div>`);
  dialog.querySelectorAll<HTMLButtonElement>('.bet-choice').forEach(button => button.addEventListener('click', () => { bet = Number(button.dataset.value); retryRequestId = null; updateUI(); dialog.close(); }));
}
document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => button.addEventListener('click', () => {
  const action = button.dataset.action;
  if (action !== 'sound') audio.click();
  if (action === 'rules') showRules();
  if (action === 'history') void showHistory();
  if (action === 'settings') showSettings();
  if (action === 'auto') showAuto();
  if (action === 'bet') showBets();
  if (action === 'minus' || action === 'plus') { if (!busy && session && !session.freeSpins && !autoplay.active) { const index = session.betChoices.indexOf(bet); bet = session.betChoices[Math.max(0, Math.min(session.betChoices.length - 1, index + (action === 'plus' ? 1 : -1)))]; retryRequestId = null; updateUI(); } }
  if (action === 'sound') { audio.setEnabled(!audio.enabled); void unlockSound(); savePref('tt-sound', String(audio.enabled)); updateUI(); }
  if (action === 'audio-start') { audio.setEnabled(true); audio.setMusicEnabled(true); if (!audio.musicVolume) audio.setMusicVolume(.6); savePref('tt-sound', 'true'); savePref('tt-music', 'true'); savePref('tt-music-volume', String(audio.musicVolume)); void unlockSound(); updateUI(); }
  if (action === 'turbo') { turbo = !turbo; savePref('tt-turbo', String(turbo)); updateUI(); }
  if (action === 'language') { locale = locale === 'zh' ? 'en' : locale === 'en' ? 'ar' : 'zh'; savePref('tt-language', locale); updateUI(); if (!busy) message(cp('ready')); }
  if (action === 'fullscreen') { if (document.fullscreenElement) void document.exitFullscreen(); else if (shell.requestFullscreen) void shell.requestFullscreen().catch(() => {}); }
}));
spinButton.addEventListener('click', () => void spin());
$('.panel-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
$('.celebration-close').addEventListener('click', closeCelebration);
$('.celebration-auto-stop').addEventListener('click', () => stopAuto(true));
document.addEventListener('keydown', e => { if (e.code === 'Space' && !dialog.open && !busy && !previewing && !autoplay.active && e.target === document.body) { e.preventDefault(); void spin(); } if (e.key === 'Escape' && !$('.celebration').hidden) closeCelebration(); });
document.addEventListener('visibilitychange', () => { document.body.classList.toggle('scene-paused', document.hidden); if (document.hidden) stopAuto(); setTimeout(updateAudioUI, 100); });
const gestureAudio = (e: Event) => { if (!(e.target instanceof Element) || e.target.closest('[data-action="sound"], [data-setting="sound"], [data-setting="music"], [data-setting="sfx"]')) return; void unlockSound(); };
document.addEventListener('pointerdown', gestureAudio, { capture: true, passive: true });
document.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') gestureAudio(e); }, { capture: true });
window.addEventListener('pagehide', () => { stopAuto(); character.dispose(); motion.dispose(); audio.dispose(); });
autoplay = new AutoPlay({
  getState: () => ({ freeSpins: session?.freeSpins ?? 0, canPlay: !!session && !busy && !previewing && !document.hidden && !dialog.open && !session.pendingRound && (session.freeSpins > 0 || session.balance >= bet) }),
  play: () => spin(true),
  onChange: () => updateUI(),
  betweenRounds: () => wait(turbo ? 400 : 850),
});
renderBoard(INITIAL_BOARD); updateUI(); void connect();
