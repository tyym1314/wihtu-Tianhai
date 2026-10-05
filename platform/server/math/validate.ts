import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { getProfile, createCycleRandom, generateThunderCycle, generateTigerCycle } from './index.js';
const game=process.argv[2],tier=process.argv[3]||'99',count=Number(process.argv[4]||1_000_000);
if(!Number.isSafeInteger(count)||count<1_000_000)throw new Error('Validation requires at least 1,000,000 complete paid cycles per profile');
const profile=getProfile(game,tier),bet=10000;
const seed=createHash('sha256').update(`oasis-platform-validation-2026-09-18:${game}:${tier}`).digest('hex');
const random=createCycleRandom(seed,profile.hash);
let sum=0,sumSquares=0,max=0,hits=0,bonus=0,freeRounds=0,capCount=0,freeLimitCount=0,rounds=0;
const started=performance.now();
for(let i=0;i<count;i++){
  const r=game==='thunder'?generateThunderCycle(bet,profile,random):generateTigerCycle(bet,profile,random);
  const m=r.grossPayoutMinor/bet;sum+=m;sumSquares+=m*m;max=Math.max(max,m);if(m>0)hits++;
  if(r.freeSpinsPlayed>0)bonus++;freeRounds+=r.freeSpinsPlayed;rounds+=r.rounds.length;
  capCount+=Number(r.cycleWinCapReached);freeLimitCount+=Number(r.cycleFreeSpinLimitReached);
  if((i+1)%250000===0)process.stderr.write(`${game}/${tier}: ${i+1}/${count} complete cycles\n`);
}
const mean=sum/count;const variance=Math.max(0,(sumSquares-count*mean*mean)/(count-1));const se=Math.sqrt(variance/count);
const ci=[mean-1.96*se,mean+1.96*se];
const report={status:'DEVELOPMENT_MONTE_CARLO_NOT_CERTIFIED',gameId:game,profile:tier,mathVersion:profile.version,mathConfigHash:profile.hash,
 generatedAt:new Date().toISOString(),countPaidCycles:count,stakeMinor:bet,seedHex:seed,rng:'Domain-separated AES-256-CTR continuous test stream with rejection sampling; same production complete-cycle payout kernels; production uses independent random 256-bit seed per paid cycle.',
 observedRtp:mean,targetRtp:profile.targetRtp,normalApproximation95:ci,standardError:se,targetInsideInterval:ci[0]<=profile.targetRtp&&profile.targetRtp<=ci[1],
 hitRate:hits/count,bonusEntries:bonus,freeRounds,totalPresentationRounds:rounds,maxObservedGrossMultiple:max,provenGrossUpperBoundMultiple:profile.maxMultiplier,
 grossCapEvents:capCount,freeSpinLimitEvents:freeLimitCount,elapsedSeconds:(performance.now()-started)/1000,
 implementationSha256:createHash('sha256').update(await readFile(new URL('./index.ts',import.meta.url))).digest('hex'),config:profile.config,
 limitations:'Statistical estimate at one stake, not exact theoretical RTP or certification. CI is an approximate interval for independent complete-cycle mean. Bounded-platform Thunder differs from original demo in bonus length/cycle cap. 98 scales symbol/line awards by 98/99 with floor before multipliers, so observed RTP is not forced to 98%. Max observed payout is not the proven maximum.'};
await mkdir('platform/review',{recursive:true});await writeFile(`platform/review/math-${game}-${tier}.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({game,tier,count,observedRtp:mean,confidence95:ci,targetInsideInterval:report.targetInsideInterval,seconds:report.elapsedSeconds},null,2));
