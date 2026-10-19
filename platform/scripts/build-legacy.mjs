import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import {rewriteLegacyMobileAssets} from './legacy-mobile-assets.mjs';
import {localizeLegacyFonts} from '../shared/fonts/legacy-fonts.mjs';
import {prepareLegacyAudio} from '../legacy/audio-preparation-transform.mjs';
const platform=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const repo=path.dirname(platform),stage=path.join(platform,'.local/legacy-src'),out=path.join(platform,'legacy/dist');
const sha=text=>createHash('sha256').update(text).digest('hex');
const mobileAssets=JSON.parse(await readFile(path.join(platform,'mobile-assets.json'),'utf8')).filter(a=>a.source.startsWith('public/'));
for(const asset of mobileAssets){
 if(sha(await readFile(path.join(repo,asset.source)))!==asset.source_sha256||sha(await readFile(path.join(repo,asset.target)))!==asset.target_sha256)throw new Error('Mobile asset source/output drift: '+asset.source);
}
const mobileSource=text=>rewriteLegacyMobileAssets(text,mobileAssets);
const originals=new Map();
async function files(dir){let list=[];for(const d of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,d.name);if(d.isDirectory())list.push(...await files(p));else list.push(p);}return list;}
for(const file of await files(path.join(repo,'src')))originals.set(file,sha(await readFile(file)));
await mkdir(stage,{recursive:true});await cp(path.join(repo,'src'),path.join(stage,'src'),{recursive:true});
const fontDirectory=path.join(platform,'shared/fonts');
const fontManifest=JSON.parse(await readFile(path.join(fontDirectory,'manifest.json'),'utf8'));
for(const font of fontManifest.fonts){
 for(const [file,hash] of [[font.file,font.sha256],[font.license_file,font.license_sha256],[font.css_file,font.css_sha256]]){
  if(sha(await readFile(path.join(fontDirectory,file)))!==hash)throw new Error('Vendored font/license drift: '+file);
 }
}
await cp(fontDirectory,path.join(stage,'fonts'),{recursive:true});
for(const [game,relative] of [['thunder','src/style.css'],['tiger','src/tiger/style.css']]){
 const file=path.join(stage,relative);
 // Inside an App WebView that draws under the status bar, keep the header below the host's top inset
 // (--oasis-host-inset-top is set by the host bridge from the App's safe area).
 // The demo/platform corner badge means nothing to players and sits where the App's back button goes.
 // Production presentation: the App's back button takes the top-left corner (the duplicate rules
 // button and demo badge go; HOW TO PLAY stays), music starts with the first tap (no TAP FOR MUSIC
 // badge), demo previews/reset/sound-test and the platform footer are hidden, and the balance shows
 // a "+" that opens the App's top-up.
 const plus='.th-plus{display:inline-grid;place-items:center;width:18px;height:18px;margin-inline-start:6px;border-radius:50%;font:700 15px/1 system-ui;vertical-align:middle;cursor:pointer}';
 const inset=game==='thunder'
  ?'\n.game-shell{padding-top:var(--oasis-host-inset-top,0px);box-sizing:border-box}\n.demo-badge,.info-button,.audio-status-badge,.game-footer,.audio-test-button,.setting-section:has(.preview-actions){display:none!important}\n'+plus+'.th-plus{background:linear-gradient(#ffe7a3,#d39a33);color:#3a2207;box-shadow:0 1px 3px #0008}\n'
  :'\n.tiger-game{padding-top:var(--oasis-host-inset-top,0px);box-sizing:border-box}\n.demo-pill,.music-status,.tiger-game footer,[data-action=sound-test],[data-action=reset],[data-action=reset-confirm],.preview-buttons,.preview-buttons+.muted-note,h3:has(+.preview-buttons){display:none!important}\n'+plus+'.th-plus{background:linear-gradient(#ffdf8a,#c9871f);color:#5a1d00;box-shadow:0 1px 3px #0006}\n';
 await writeFile(file,localizeLegacyFonts(await readFile(file,'utf8'),game)+inset);
}
await cp(path.join(platform,'legacy/bridge.ts'),path.join(stage,'bridge.ts'));
await cp(path.join(platform,'legacy/host-bridge.mjs'),path.join(stage,'host-bridge.mjs'));
for(const file of await files(path.join(stage,'src'))){
 if(!/\.(ts|css)$/.test(file))continue;
 const text=await readFile(file,'utf8');
 await writeFile(file,text.replaceAll('/assets/','/legacy/assets/'));
}
// Prepare the same PCM bank and host gain layer for both isolated legacy games.
for(const relative of ['src/ui/audio.ts','src/tiger/audio.ts']){
 const file=path.join(stage,relative);
 const audio=prepareLegacyAudio(await readFile(file,'utf8'));
 await writeFile(path.join(path.dirname(file),'audio-synthesis.ts'),audio.synthesis);
 await writeFile(path.join(path.dirname(file),'audio-worker.ts'),audio.worker);
 await writeFile(file,audio.source);
}
const thunderFile=path.join(stage,'src/main.ts');let thunder=await readFile(thunderFile,'utf8');
thunder=thunder.replace("import { GAME_CONFIG, INITIAL_BOARD, SYMBOLS } from './game/engine';",`import { GAME_CONFIG as LEGACY_GAME_CONFIG, INITIAL_BOARD, SYMBOLS } from './game/engine';\nimport { platformConfig } from '../bridge';\nconst GAME_CONFIG = { ...LEGACY_GAME_CONFIG, get targetRtp() { return platformConfig.targetRtp ?? LEGACY_GAME_CONFIG.targetRtp; }, get paytableScale() { return LEGACY_GAME_CONFIG.paytableScale * (platformConfig.payoutScale?.numerator ?? 1) / (platformConfig.payoutScale?.denominator ?? 1); }, get mathVersion() { return platformConfig.version ?? platformConfig.mathVersion ?? LEGACY_GAME_CONFIG.mathVersion; } };`);
thunder=thunder.replace('cumulative += step.baseWin / 100;','cumulative += (result.cycleWinCapReached ? step.settledWin : step.baseWin) / 100;');
thunder=thunder.replace("${number(step.baseWin / 100)}","${number((result.cycleWinCapReached ? step.settledWin : step.baseWin) / 100)}");
// Only monetary minor-unit expressions change units; percentages/paytables stay exact.
thunder=thunder.replaceAll('(result.cycleWinCapReached ? step.settledWin : step.baseWin) / 100','(result.cycleWinCapReached ? step.settledWin : step.baseWin) / (platformConfig.unitsPerCoin ?? 100)');
thunder=thunder.replaceAll('number(result.baseWin / 100)', 'number(result.baseWin / (platformConfig.unitsPerCoin ?? 100))');
thunder=thunder.replace('MAX ${GAME_CONFIG.maxWinMultiple}×','MAX ${result.cycleWinCapReached ? 10000 : GAME_CONFIG.maxWinMultiple}×');
thunder=thunder.replaceAll("${cp('target')} 99%","${cp('target')} ${Math.round(GAME_CONFIG.targetRtp * 100)}%");
thunder=thunder.replace("['INTERNAL_ERROR', 'HTTP_ERROR']","['INTERNAL_ERROR', 'HTTP_ERROR', 'SETTLEMENT_PENDING', 'WALLET_PENDING']");
thunder=thunder.replace('displayBalance = round.balanceBefore - (round.isFreeSpin ? 0 : round.bet);','displayBalance = finalSession.balance;');
thunder=thunder.replaceAll('DEMO CREDITS · NO CASH VALUE','APP WALLET · VIRTUAL CREDITS');
const demos=[
 ['rulesDemo',[
  '平台 App 钱包结算。98/99 为版本化长期 RTP 目标，非每局中奖概率或认证值；98 档按 98/99 缩放符号派彩并向下取整。完整付费周期含全部免费转，仅扣一次投入。演出开始前完整周期已结算，余额显示 App 钱包可用余额；免费演出不再次扣款或派奖。',
  'App wallet settlement. 98/99 are versioned long-run targets, not win probability or certification. The 98 profile scales symbol awards by 98/99 and rounds down. One stake covers the complete free-spin cycle. The full cycle settles before presentation; balance shows available App credits. Free-spin presentation makes no further debit or credit.',
  'تتم التسوية عبر محفظة التطبيق. النسب أهداف طويلة الأجل وليست احتمال الفوز. يشمل الرهان دورة اللفات المجانية كاملة. تتم تسوية الدورة قبل العرض ويظهر الرصيد المتاح؛ عرض اللفات المجانية لا يخصم أو يضيف رصيداً مرة أخرى.'
 ]],
 ['noMoney',[
  'App 可用金币不足，请返回应用查看余额。',
  'Not enough available App credits. Return to the App to review your balance.',
  'رصيد التطبيق المتاح غير كافٍ. يرجى العودة إلى التطبيق.'
 ]],
 ['loading',[
  '正在连接 App 钱包…',
  'Connecting to App wallet…',
  'جارٍ الاتصال بمحفظة التطبيق…'
 ]],
 ['limits',[
  '平台版本：单转最高 1,000 倍，完整付费周期最高 10,000 倍，最多 100 次免费转；达到上限后按规则结束。',
  'Platform version: 1,000x maximum per spin, 10,000x per paid cycle, at most 100 free spins. Reaching a limit ends the feature under the published rules.',
  'الحد 1000 ضعف لكل لفة و10000 ضعف للدورة الكاملة، وبحد أقصى 100 لفة مجانية.'
 ]]
];
for(const [key,values] of demos){let i=0;thunder=thunder.replace(new RegExp(`${key}: '[^']*'`,'g'),()=>`${key}: ${JSON.stringify(values[i++])}`);if(i!==3)throw new Error(`Unexpected Thunder ${key} copies: ${i}`);}
thunder=thunder.replaceAll('Connecting to demo wallet…','Connecting to App wallet…').replaceAll('正在连接演示钱包…','正在连接 App 钱包…');
thunder+=`\nimport {registerPresentationHost} from '../bridge';\nregisterPresentationHost({prepareBack:()=>{autoplay?.stop();updateUI();return{pending:busy||!!retryRequestId||!!session?.pendingRound};}});\n`;
await cp(path.join(platform,'legacy/art/thunder-responsive.css'),path.join(stage,'src/platform-responsive.css'));
thunder+=`\nimport './platform-responsive.css';\n`;
// Host App top-up: not enough coins or a tap on the balance opens the App's own top-up page;
// after it the App asks for a balance refresh.
const mustReplace=(text,from,to,label)=>{if(!text.includes(from))throw new Error('Legacy transform anchor missing: '+label);return text.replace(from,to);};
thunder=mustReplace(thunder,"toast(cp('noMoney'));","toast(cp('noMoney'));requestHostRecharge('insufficient');",'thunder noMoney');
thunder=mustReplace(thunder,"import { platformConfig } from '../bridge';","import { platformConfig, requestHostRecharge, onHostBalanceRefresh } from '../bridge';",'thunder bridge import');
thunder+="\nonHostBalanceRefresh(async()=>{try{session=await api<Session>('session');displayBalance=session.balance;updateUI();}catch{}});\ndocument.getElementById('balance')?.closest('.stat')?.addEventListener('click',()=>requestHostRecharge('user'));\n{const b=document.getElementById('balance');if(b&&!b.parentElement?.querySelector('.th-plus')){const p=document.createElement('i');p.className='th-plus';p.textContent='+';p.setAttribute('aria-hidden','true');b.after(p);}}\n";
await writeFile(thunderFile,thunder);
const tigerFile=path.join(stage,'src/tiger/main.ts');let tiger=await readFile(tigerFile,'utf8');
tiger=tiger.replace("import { TIGER_CONFIG } from './math';",`import { TIGER_CONFIG as LEGACY_TIGER_CONFIG } from './math';\nimport { platformConfig } from '../../bridge';\nconst TIGER_CONFIG = { ...LEGACY_TIGER_CONFIG, get targetRtp() { return platformConfig.targetRtp ?? LEGACY_TIGER_CONFIG.targetRtp; }, get mathVersion() { return platformConfig.version ?? platformConfig.mathVersion ?? LEGACY_TIGER_CONFIG.mathVersion; }, get symbols() { const scale=platformConfig.payoutScale ?? {numerator:1,denominator:1}; return LEGACY_TIGER_CONFIG.symbols.map(s => ({...s,payoutBps:s.payoutBps*scale.numerator/scale.denominator})); } };`);
const copyUpdates={
 zh:{demo:'平台游戏',demoNote:'App 虚拟币',noFunds:'App 可用金币不足，请返回应用查看余额。',mathText:'平台独立数学模型，目标由当前版本决定；98 档把基准逐线派彩按 98/99 缩放并向下取整，再应用满盘倍率。统计验证不是精确理论值或认证。演出开始前完整周期已结算，余额显示 App 钱包可用余额；重转演出不再次扣款或派奖。'},
 en:{demo:'PLATFORM',demoNote:'APP VIRTUAL CREDITS',noFunds:'Not enough available App credits. Return to your App.',mathText:'Independent platform model. Target follows the active version. The 98 profile scales each base line award by 98/99 and rounds down before the full-board multiplier. Monte Carlo is not a theoretical proof or certification. The full cycle settles before presentation; balance shows available App credits. Respin presentation makes no further debit or credit.'},
 ar:{demo:'المنصة',demoNote:'رصيد التطبيق الافتراضي',noFunds:'رصيد التطبيق المتاح غير كافٍ.',mathText:'نموذج مستقل للمنصة. العائد المستهدف حسب الإصدار الحالي؛ التحقق الإحصائي ليس شهادة أو احتمال فوز لكل جولة. تتم التسوية قبل العرض ويظهر الرصيد المتاح؛ عرض إعادة التدوير لا يخصم أو يضيف رصيداً مرة أخرى.'}
};
tiger=tiger.replace('const pref=',`for (const [language,values] of Object.entries(${JSON.stringify(copyUpdates)})) Object.assign(copies[language as Locale],values);\nconst pref=`);
tiger=tiger.replace('String(s.payoutBps/10000)',"new Intl.NumberFormat('en-US',{maximumFractionDigits:6}).format(s.payoutBps/10000)");
tiger=tiger.replace("['INTERNAL_ERROR','HTTP_ERROR']","['INTERNAL_ERROR','HTTP_ERROR','SETTLEMENT_PENDING','WALLET_PENDING']");
tiger=tiger.replace('displayBalance=round.balanceBefore-round.bet;','displayBalance=finalSession.balance;');
tiger+=`\nimport {registerPresentationHost} from '../../bridge';\nregisterPresentationHost({prepareBack:()=>{autoplay.stop();updateUI();return{pending:busy||!!retryId||!!session?.pendingRound};}});\n`;
await cp(path.join(platform,'legacy/art/tiger-restoration.css'),path.join(stage,'src/tiger/platform-restoration.css'));
tiger+=`\nimport './platform-restoration.css';\n`;
tiger=mustReplace(tiger,"toast(t('noFunds'));","toast(t('noFunds'));requestHostRecharge('insufficient');",'tiger noFunds');
tiger=mustReplace(tiger,"import { platformConfig } from '../../bridge';","import { platformConfig, requestHostRecharge, onHostBalanceRefresh } from '../../bridge';",'tiger bridge import');
tiger+="\nonHostBalanceRefresh(async()=>{try{session=await api<TigerSession>('session');displayBalance=session.balance;updateUI();}catch{}});\ndocument.getElementById('balance')?.closest('.wallet-cell')?.addEventListener('click',()=>requestHostRecharge('user'));\n{const b=document.getElementById('balance');if(b&&!b.parentElement?.querySelector('.th-plus')){const p=document.createElement('i');p.className='th-plus';p.textContent='+';p.setAttribute('aria-hidden','true');b.after(p);}}\n";
await writeFile(tigerFile,tiger);
const translationsFile=path.join(stage,'src/ui/i18n.ts');let translations=await readFile(translationsFile,'utf8');
translations=translations.replace("demo: 'DEMO'","demo: 'PLATFORM'").replace("demo: '试玩版'","demo: '平台游戏'").replace("demo: 'نسخة تجريبية'","demo: 'المنصة'");
await writeFile(translationsFile,translations);
for(const [game,entry] of [['thunder','./src/main'],['tiger','./src/tiger/main']]){
 const images=mobileAssets.filter(a=>game==='tiger'?a.original_url.includes('/tiger/'):!a.original_url.includes('/tiger/')).map(a=>'/legacy'+a.optimized_url);
 await writeFile(path.join(stage,`boot-${game}.ts`),`import { boot } from './bridge';\nconst artReady=Promise.all(${JSON.stringify(images)}.map(url=>new Promise<void>((resolve,reject)=>{const image=new Image();const timeout=setTimeout(()=>reject(new Error('游戏画面加载超时，请重新进入')),20000);image.decoding='async';image.onload=()=>{image.decode().then(()=>{clearTimeout(timeout);resolve();},()=>{clearTimeout(timeout);resolve();});};image.onerror=()=>{clearTimeout(timeout);reject(new Error('游戏画面加载失败，请重新进入'));};image.src=url;})));\nvoid artReady.catch(()=>{});\nvoid boot('${game}',async()=>{await artReady;return import('${entry}');});\n`);
 const original=await readFile(path.join(repo,game==='thunder'?'index.html':'tiger.html'),'utf8');
 const html=original.replace(/src="\/src\/(?:tiger\/)?main\.ts"/,`src="/boot-${game}.ts"`).replaceAll('/assets/','/legacy/assets/').replaceAll('href="/favicon.svg"','href="/legacy/favicon.svg"').replaceAll('href="/tiger-favicon.svg"','href="/legacy/tiger-favicon.svg"');
 await writeFile(path.join(stage,`${game}.html`),html);
}
// Optimize the isolated platform presentation only; original prototype sources
// and original PNGs remain unchanged. All image dimensions/alpha are retained.
for(const file of await files(stage))if(/\.(ts|css|html)$/.test(file))await writeFile(file,mobileSource(await readFile(file,'utf8')));
await build({configFile:false,root:stage,base:'/legacy/',publicDir:path.join(repo,'public'),build:{outDir:out,emptyOutDir:true,target:'es2022',assetsDir:'bundles',rollupOptions:{input:{thunder:path.join(stage,'thunder.html'),tiger:path.join(stage,'tiger.html')}}}});
await mkdir(path.join(out,'font-licenses'),{recursive:true});
for(const font of fontManifest.fonts)await cp(path.join(fontDirectory,font.license_file),path.join(out,'font-licenses',font.license_file));
await cp(path.join(fontDirectory,'manifest.json'),path.join(out,'font-licenses/manifest.json'));
for(const [file,before] of originals)if(sha(await readFile(file))!==before)throw new Error(`Original source changed during isolated build: ${file}`);
const manifest={generatedAt:new Date().toISOString(),status:'PLATFORM_PRESENTATION_BUILD',sourceFilesVerifiedUnchanged:originals.size,outputDirectory:path.relative(repo,out),htmlRoutes:['/play/thunder','/play/tiger'],assetBase:'/legacy/',authentication:'server-bound host-origin and nonce channel; one-time code; Bearer in game bridge memory only',originalSources:[...originals].map(([file,hash])=>({path:path.relative(repo,file),sha256:hash}))};
await writeFile(path.join(platform,'legacy/build-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Legacy platform presentations built; ${originals.size} original source files unchanged.`);
