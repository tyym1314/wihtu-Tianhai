import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { generateRound, GAME_CONFIG, type RoundResult, type RandomSource } from '../../../src/game/engine.js';
import { generateTigerRound, TIGER_CONFIG } from '../../../src/tiger/math.js';
import type { TigerRoundResult } from '../../../src/tiger/types.js';

export type ProbabilityGame = 'thunder' | 'tiger';
export type ProfileName = '96' | '97' | '98' | '99';
export const PROFILE_NAMES: readonly ProfileName[] = ['96', '97', '98', '99'];
export interface MathProfile {
  gameId: ProbabilityGame; profile: ProfileName; version: string; hash: string;
  targetRtp: number; maxMultiplier: number; config: Record<string, unknown>;
}
export interface PlatformRoundFields {
  mathConfigHash: string; cycleIndex: number; cycleWinCapReached: boolean;
  cycleFreeSpinLimitReached: boolean; freeSpinsBefore: number; freeSpinsAfter: number;
  rawTotalWin: number; payoutScale: { numerator: number; denominator: number };
}
export type PlatformRound = (RoundResult | TigerRoundResult) & PlatformRoundFields;
export interface CycleResult {
  gameId: ProbabilityGame; profile: ProfileName; mathVersion: string; mathConfigHash: string;
  stakeMinor: number; grossPayoutMinor: number; rounds: PlatformRound[];
  freeSpinsPlayed: number; cycleWinCapReached: boolean; cycleFreeSpinLimitReached: boolean;
  maxPayoutMinor: number; seedHash: string; resultHash: string;
}
const scales = { '99': { numerator: 1, denominator: 1 }, '98': { numerator: 98, denominator: 99 }, '97': { numerator: 97, denominator: 99 }, '96': { numerator: 96, denominator: 99 } } as const;
const MAX_FREE_SPINS = 100;
const THUNDER_CYCLE_CAP = 10_000;
// Bet levels in minor units. v1 (until 2026-10-20) stays loadable so cycles pinned to it still recover.
const BETS_V1 = [1_000, 5_000, 10_000, 20_000, 50_000];
const BETS = [500, 1_000, 5_000, 10_000, 50_000, 100_000];
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key,val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`).join(',')}}`;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function defineProfile(gameId: ProbabilityGame, profile: ProfileName, generation = 2): MathProfile {
  const version = `${gameId}-platform-${profile}-v${generation}`;
  const maxMultiplier = gameId === 'thunder' ? THUNDER_CYCLE_CAP : 455;
  const config = JSON.parse(JSON.stringify({
    sourceMathVersion: gameId === 'thunder' ? GAME_CONFIG.mathVersion : TIGER_CONFIG.mathVersion,
    // v1 keeps the engine limits it was frozen with (minimum stake 1000 minor units).
    baseConfig: gameId === 'thunder' ? (generation === 1 ? { ...GAME_CONFIG, minBet: 1000 } : GAME_CONFIG) : TIGER_CONFIG,
    mathVersion: version, targetRtp: Number(profile) / 100, payoutScale: scales[profile],
    payoutRounding: 'floor each symbol/line award after rational scaling, then apply the feature multiplier',
    currencyScale: 100, stakeMinorChoices: generation === 1 ? BETS_V1 : BETS,
    completeCycleMaximumMultiplier: maxMultiplier,
    ...(gameId === 'thunder' ? { maxFreeSpinsPerPaidCycle: MAX_FREE_SPINS, maxWinPerPaidCycle: THUNDER_CYCLE_CAP,
      capRule: 'clip the final accepted round to remaining gross allowance; no further bonus obligations once cap reached; total granted/played free spins cannot exceed 100' }
      : { maxRespins: TIGER_CONFIG.maxRespins, finalBoardOnlyPaid: true, fullBoardMultiplier: 10,
          maxPayoutProof: '5 lines * floor(stake*91000/10000) * 10; 98 profile line scaling only lowers this bound' }),
    rng: 'AES-256-CTR stream; HMAC-SHA256 domain-derived key from 256-bit seed; rejection-sampled uint32',
    validation: 'development Monte Carlo required; not a certified theoretical RTP',
  }));
  return freeze({ gameId, profile, version, hash: hash(config), targetRtp: Number(profile) / 100, maxMultiplier, config });
}
const tiers = (game: ProbabilityGame, generation = 2) => Object.fromEntries(PROFILE_NAMES.map(p => [p, defineProfile(game, p, generation)])) as Record<ProfileName, MathProfile>;
const profiles = { thunder: tiers('thunder'), tiger: tiers('tiger') };
const byVersion = new Map([...Object.values(profiles), tiers('thunder', 1), tiers('tiger', 1)].flatMap(t => Object.values(t)).map(m => [m.version, m]));
/** Every loadable profile (current and pinned legacy versions), for wallet registration and recovery. */
export function allProfiles(): MathProfile[] { return [...byVersion.values()]; }
export function getProfileByVersion(version: string): MathProfile | undefined { return byVersion.get(version); }
export function getProfile(gameId: string, profile = '99'): MathProfile {
  if (gameId !== 'thunder' && gameId !== 'tiger') throw new RangeError('Unknown probability game');
  if (!(PROFILE_NAMES as readonly string[]).includes(profile)) throw new RangeError('Unknown math profile');
  return profiles[gameId][profile];
}
/** Deterministic cryptographic stream for a server-generated 256-bit seed. Never use 32-bit simulation seeds in production. */
export function createCycleRandom(seedHex: string, domain: string): RandomSource {
  if (!/^[a-fA-F0-9]{64}$/.test(seedHex)) throw new RangeError('seedHex must encode 32 bytes');
  const key = createHmac('sha256', Buffer.from(seedHex,'hex')).update(`oasis-paid-cycle-rng-v1\0${domain}`).digest();
  const cipher = createCipheriv('aes-256-ctr',key,Buffer.alloc(16));
  const zeros = Buffer.alloc(256); let buffer = Buffer.alloc(0); let cursor = 0;
  const word = () => { if (cursor >= buffer.length) { buffer = cipher.update(zeros); cursor = 0; } const n=buffer.readUInt32BE(cursor); cursor+=4; return n; };
  return max => {
    if (!Number.isSafeInteger(max) || max < 1 || max > 0x100000000) throw new RangeError('Invalid RNG range');
    const limit=Math.floor(0x100000000/max)*max; let n:number;
    do { n=word(); } while(n>=limit);
    return n%max;
  };
}
const scaled = (amount: number, profile: ProfileName) => {
  const { numerator, denominator } = scales[profile];
  // Current profile stakes and awards stay below Number.MAX_SAFE_INTEGER / 100.
  if (!Number.isSafeInteger(amount*numerator)) throw new RangeError('Unsafe payout scale');
  return Math.floor(amount*numerator/denominator);
};
function scaleThunder(raw: RoundResult, profile: ProfileName): RoundResult {
  if (profile==='99') return raw;
  const steps=raw.steps.map(step=>{ const wins=step.wins.map(win=>({...win,payout:scaled(win.payout,profile)})); return {...step,wins,baseWin:wins.reduce((sum,w)=>sum+w.payout,0)}; });
  const baseWin=steps.reduce((sum,s)=>sum+s.baseWin,0);
  const uncapped=baseWin*raw.multiplier;
  return {...raw,steps,baseWin,totalWin:Math.min(raw.bet*GAME_CONFIG.maxWinMultiple,uncapped),winCapReached:uncapped>raw.bet*GAME_CONFIG.maxWinMultiple};
}
function scaleTiger(raw: TigerRoundResult, profile: ProfileName): TigerRoundResult {
  if(profile==='99')return raw;
  const steps=raw.steps.map(step=>{const lineWins=step.lineWins.map(win=>({...win,payout:scaled(win.payout,profile)}));return {...step,lineWins,baseWin:lineWins.reduce((sum,w)=>sum+w.payout,0)};});
  const baseWin=steps.at(-1)!.baseWin;
  return {...raw,steps,baseWin,totalWin:baseWin*raw.multiplier};
}
/** Adds exact gross attribution for animation/replay, including the last clipped win. */
function grossStepAwards(round: RoundResult) {
  let remaining=round.totalWin;
  return round.steps.map(step=>{const settledWin=Math.min(remaining,step.baseWin*round.multiplier);remaining-=settledWin;return {...step,settledWin};});
}
/** Internal deterministic cycle helper. Generator injection exists for hard-cap boundary tests, not HTTP inputs. */
export function generateThunderCycle(stakeMinor: number, profile: MathProfile, random: RandomSource, generate: typeof generateRound = generateRound) {
  const maxPayout=stakeMinor*THUNDER_CYCLE_CAP; const rounds: PlatformRound[]=[];
  let remaining=0, multiplier=0, freePlayed=0, gross=0, freeLimit=false, cap=false;
  do {
    const before=remaining, isFree=rounds.length>0;
    const original=generate({bet:stakeMinor,freeSpins:before,freeMultiplier:multiplier},random);
    const round=scaleThunder(original,profile.profile);
    if(isFree) freePlayed++;
    const afterConsumed=Math.max(0,before-(isFree?1:0));
    const grantRoom=Math.max(0,MAX_FREE_SPINS-freePlayed-afterConsumed);
    const awarded=Math.min(round.freeSpinsAwarded,grantRoom);
    const limited=awarded!==round.freeSpinsAwarded;
    remaining=afterConsumed+awarded;
    const paid=Math.min(round.totalWin,maxPayout-gross);
    gross+=paid;
    const clipped=paid<round.totalWin;
    cap=cap||gross===maxPayout;
    freeLimit=freeLimit||limited;
    if(cap) remaining=0;
    multiplier=remaining>0?round.nextFreeMultiplier:0;
    const result: PlatformRound={...round,mathVersion:profile.version,mathConfigHash:profile.hash,cycleIndex:rounds.length,
      totalWin:paid,rawTotalWin:round.totalWin,freeSpinsAwarded:cap?0:awarded,nextFreeMultiplier:multiplier,
      winCapReached:round.winCapReached||clipped,cycleWinCapReached:cap,cycleFreeSpinLimitReached:limited,
      freeSpinsBefore:before,freeSpinsAfter:remaining,payoutScale:{...scales[profile.profile]}};
    result.steps=grossStepAwards(result as RoundResult);
    rounds.push(result);
  } while(remaining>0 && freePlayed<MAX_FREE_SPINS && !cap);
  if (remaining!==0) throw new Error('Unfulfilled bounded bonus state');
  return {rounds,grossPayoutMinor:gross,freeSpinsPlayed:freePlayed,cycleWinCapReached:cap,cycleFreeSpinLimitReached:freeLimit};
}
/** Same payout kernel used by production and complete-cycle Monte Carlo validation. */
export function generateTigerCycle(stakeMinor: number, selected: MathProfile, random: RandomSource) {
  const round=scaleTiger(generateTigerRound({bet:stakeMinor},random),selected.profile);
  const result: PlatformRound={...round,mathVersion:selected.version,mathConfigHash:selected.hash,cycleIndex:0,
    rawTotalWin:round.totalWin,cycleWinCapReached:false,cycleFreeSpinLimitReached:false,freeSpinsBefore:0,freeSpinsAfter:0,payoutScale:{...scales[selected.profile]}};
  return {rounds:[result],grossPayoutMinor:result.totalWin,freeSpinsPlayed:0,cycleWinCapReached:false,cycleFreeSpinLimitReached:false};
}
export function playCycle(gameId: string, stakeMinor: number, profile = '99', seedHex: string, version?: string): CycleResult {
  const pinned=version?byVersion.get(version):undefined;
  if(version&&(!pinned||pinned.gameId!==gameId)) throw new RangeError('Unknown math version');
  const selected=pinned||getProfile(gameId,profile);
  if(!Number.isSafeInteger(stakeMinor)||!(selected.config.stakeMinorChoices as number[]).includes(stakeMinor)) throw new RangeError('Unsupported integer minor-unit stake');
  const random=createCycleRandom(seedHex,selected.hash);
  let data: ReturnType<typeof generateThunderCycle>;
  if(selected.gameId==='thunder') data=generateThunderCycle(stakeMinor,selected,random);
  else data=generateTigerCycle(stakeMinor,selected,random);
  const result={gameId:selected.gameId,profile:selected.profile,mathVersion:selected.version,mathConfigHash:selected.hash,
    stakeMinor,...data,maxPayoutMinor:stakeMinor*selected.maxMultiplier,seedHash:createHash('sha256').update(Buffer.from(seedHex,'hex')).digest('hex')};
  if(!Number.isSafeInteger(result.grossPayoutMinor)||result.grossPayoutMinor<0||result.grossPayoutMinor>result.maxPayoutMinor) throw new Error('Cycle payout invariant failed');
  if(result.rounds.reduce((sum,r)=>sum+r.totalWin,0)!==result.grossPayoutMinor) throw new Error('Round payout conservation failed');
  return {...result,resultHash:hash(result)};
}
