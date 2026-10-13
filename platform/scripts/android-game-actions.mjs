/**
 * UI-only smoke actions for released arena games, driven from Node/Playwright.
 *
 * Usage: await playOneArenaAction(actualArenaFrame, 'ludo', () => latestRoom).
 * Start/ready a practice room first. readRoom supplies the latest network room
 * snapshot for this frame; it must not make API mutations. This helper neither
 * starts nor exits rooms. Do not run another driver against the same frame.
 *
 * One accepted action is evidence of input/API integration, not a completed
 * match, settlement, physical finger input, or performance acceptance. Locator
 * clicks and the darts/towerlink mouse drags use browser input, never synthetic JS events.
 * Turn games can legitimately fail the 60-second bound while waiting for turns.
 *
 * Actions: match=legal adjacent swap; golf/carrom=shoot; bowling=roll;
 * run=jump; darts=hold/drag/release on the observed SVG bounds;
 * towerlink=drag an adjacent owned route; verify standing order and marching troops;
 * ludo=roll, otherwise select a legal pawn and confirm;
 * jackaroo=exchange one observed card, otherwise compose a legal card action;
 * domino=select a legal tile/end, otherwise draw/pass;
 * pool=shoot, or place a legal cue/call a pocket if that is first required.
 *
 * Rule helpers below are pure reads of the public snapshot. They never submit
 * actions, advance simulation, or access private state. All submission is UI.
 */
import { ARENA_IDS, LEGACY_IDS } from '../shared/games.mjs';
import { legalMoves as matchLegalMoves } from '../arena/match/engine.mjs';
import { cueDefault, POCKETS } from '../arena/pool/geometry.mjs';
import { nearestLegalOffset } from '../arena/carrom/geometry.mjs';
import { RUN_PRACTICE_PROFILES, resolveRunPracticeProfile } from '../shared/run-practice-profiles.mjs';

const GAMES = new Set(ARENA_IDS);
const LIMIT_MS = 60_000;
/** One real paid cycle only. Continue only its already-owned bonus through UI,
 * and require actual session readback after every original presentation ACK.
 * No direct POST, replay, RNG manipulation or synthetic result is supplied. */
export async function playOneProbabilityCycle(frame,game,{state,tap,readSession,assertSession,drain,beforeAction=()=>{},beforePaidSpin=async()=>{},timeoutMs=120000,now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(!LEGACY_IDS.includes(game)||typeof frame?.locator!=='function'||typeof tap!=='function'||typeof readSession!=='function'||typeof assertSession!=='function'||typeof drain!=='function')throw Error('REAL_PROBABILITY_UI_AND_READBACK_REQUIRED');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>120000)throw Error('PROBABILITY_DEADLINE_INVALID');
 const deadline=now()+timeoutMs,guard=async()=>{if(now()>=deadline)throw Error('ORIGINAL_PROBABILITY_CYCLE_DEADLINE');await beforeAction();if(now()>=deadline)throw Error('ORIGINAL_PROBABILITY_CYCLE_DEADLINE');};
 const read=async()=>{await guard();const s=await readSession();await guard();return assertSession(s);};
 const initial=await read();if(initial.pendingRound!==null||initial.freeSpins!==0||state.spins.length)throw Error('INHERITED_PROBABILITY_CYCLE_PRESERVED');
 if(!Array.isArray(initial.betChoices)||!initial.betChoices.length||initial.betChoices.some((v,i)=>!Number.isFinite(v)||v<=0||i>0&&v<=initial.betChoices[i-1]))throw Error('REAL_PROBABILITY_BET_CHOICES_REQUIRED');const selectedBet=initial.betChoices[0];if(!Number.isFinite(initial.balance)||initial.balance<selectedBet)throw Error('PROBABILITY_AVAILABLE_BALANCE_INSUFFICIENT');
 const bet=frame.locator('#bet-value');await bet.waitFor({timeout:Math.max(1,deadline-now())});await guard();await tap(bet);const choice=frame.locator(game==='tiger'?'[data-bet="'+selectedBet+'"]':'[data-value="'+selectedBet+'"]');await choice.waitFor({timeout:Math.max(1,deadline-now())});await guard();await tap(choice);
 const spin=frame.locator('#spin');await spin.waitFor({timeout:Math.max(1,deadline-now())});await guard();await beforePaidSpin();await guard();await tap(spin);
 while(now()<deadline){
  await guard();await drain();const current=await read();
  if(state.spins.filter(s=>!s.isFreeSpin).length>1)throw Error('MULTIPLE_PAID_CYCLES_REFUSED');
  const cycles=new Set(state.spins.map(s=>s.cycleId));if(cycles.size>1)throw Error('MULTIPLE_PROBABILITY_CYCLES_REFUSED');
  if(current.pendingRound&&!state.spins.some(s=>s.id===current.pendingRound.id))throw Error('UNOBSERVED_PROBABILITY_PRESENTATION_PRESERVED');
  const close=frame.locator(game==='tiger'?'#continue':'.celebration-close');
  if(await close.isVisible()){await guard();await tap(close);}
  else if(current.pendingRound===null&&current.freeSpins>0&&state.spins.length&&await spin.isEnabled()){await guard();await tap(spin);}
  else if(current.pendingRound===null&&current.freeSpins===0&&state.spins.length&&state.spins.every(s=>s.status==='SETTLED'&&state.acks.has(s.id))){await drain();await guard();return{game,selectedBet,cycleId:[...cycles][0],spins:state.spins.length,matchingAcks:state.acks.size,finalSession:current,source:'One original trusted UI paid cycle, its own natural bonus UI continuations, exact ACKs and original-session idle readback'};}
  await wait(Math.min(1000,Math.max(1,deadline-now())));
 }
 throw Error('ORIGINAL_PROBABILITY_CYCLE_DEADLINE');
}
const attr = (name, value) => {
  // These selectors only use engine-issued identifiers or numeric indices.
  if (!/^[A-Za-z0-9_:.-]+$/.test(String(value))) throw new Error(`Unsafe ${name} identifier`);
  return `[${name}="${value}"]`;
};

const safeInteger=(n,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const exactKeys=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
const inputProof=(condition,message)=>{if(!condition)throw Object.assign(new Error('run: '+message),{code:'RUN_INPUT_PROOF_INVALID'});};

// Smoke evidence only. A received GET supplies the before cursor, never an ACK.
export function runPracticeInputBaseline(room){
 if(!Object.values(RUN_PRACTICE_PROFILES).some(p=>p.ruleVersion===room?.game?.ruleVersion)){
  inputProof(!room?.run_inputs,'unsupported input profile');return null;
 }
 const a=room.run_inputs,p=room.game.players?.find(p=>p.key===room.me);
 const profile=resolveRunPracticeProfile({ruleVersion:room.game.ruleVersion,protocol:a?.protocol,profileId:a?.profileId});
 inputProof(profile,'unknown or mixed input profile');
 inputProof(room.game_id==='run'&&room.practice===true&&room.entry_minor==='0'&&room.game.me===room.me&&typeof room.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(room.id)&&typeof room.me==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(room.me),'invalid free-practice scope');
 inputProof(a.ruleVersion===profile.ruleVersion&&a.roomId===room.id&&a.playerKey===room.me&&safeInteger(a.clockEpoch,1),'invalid input protocol binding');
 if(profile.profileId)inputProof(room.fee_bps===0&&room.capacity===room.game.players?.length
  &&exactKeys(room.run_input_profile,['rule_version','protocol','profile_id'])
  &&room.run_input_profile.rule_version===profile.ruleVersion&&room.run_input_profile.protocol===profile.protocol&&room.run_input_profile.profile_id===profile.profileId,'invalid negotiated zero-fee profile');
 inputProof(Array.isArray(room.game.players)&&room.game.players.length>=2&&room.game.players.length<=4&&new Set(room.game.players.map(p=>p.key)).size===room.game.players.length&&room.game.players.every(p=>typeof p.isBot==='boolean')&&room.game.players.filter(p=>!p.isBot).length===1&&p?.isBot===false,'invalid free BOT roster');
 inputProof(safeInteger(a.revision)&&safeInteger(a.headTick,0,6000)&&room.game.snapshotTick===a.headTick&&safeInteger(a.serverTick,a.headTick,profile.serverMaxTick)&&safeInteger(a.committedThroughTick,0,a.serverTick)&&safeInteger(a.processedThroughCommandSeq)&&safeInteger(a.acceptedInputNo,0,a.processedThroughCommandSeq)&&p.inputNo===a.acceptedInputNo,'invalid input authority cursor');
 return Object.freeze({protocol:profile.protocol,ruleVersion:profile.ruleVersion,...(profile.profileId?{profileId:profile.profileId}:{}),roomId:room.id,playerKey:room.me,clockEpoch:a.clockEpoch,
  revision:a.revision,headTick:a.headTick,commandSeq:a.processedThroughCommandSeq,acceptedInputNo:a.acceptedInputNo});
}

export function verifyRunPracticeInputAction(before,request,after,{type='jump'}={}){
 const profile=resolveRunPracticeProfile(before);
 inputProof(profile,'missing before cursor');
 inputProof(exactKeys(request,['request_id','roomId','playerKey','clockEpoch','baseRevision','commands'])&&typeof request.request_id==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(request.request_id),'invalid exact request');
 inputProof(request.roomId===before.roomId&&request.playerKey===before.playerKey&&request.clockEpoch===before.clockEpoch&&safeInteger(request.baseRevision),'request scope differs');
 inputProof(Array.isArray(request.commands)&&request.commands.length===1,'expected exactly one UI command');
 const command=request.commands[0];
 inputProof(exactKeys(command,['commandSeq','type','executeTick'])&&command.commandSeq===before.commandSeq+1&&command.type===type&&safeInteger(command.executeTick,1,6001),'unexpected command sequence, type or execution tick');
 const next=runPracticeInputBaseline(after),a=after?.run_inputs;
 inputProof(next&&['roomId','playerKey','clockEpoch','protocol','ruleVersion','profileId'].every(k=>next[k]===before[k])&&after.request_id===request.request_id,'response request or scope differs');
 inputProof(next.commandSeq===command.commandSeq&&next.acceptedInputNo===before.acceptedInputNo+1&&next.revision>before.revision&&request.baseRevision<next.revision,'response does not prove one accepted input');
 inputProof(Array.isArray(a.decisions)&&a.decisions.length===1,'missing exact batch decision');
 const d=a.decisions[0];
 inputProof(exactKeys(d,['commandSeq','type','executeTick','clockEpoch','outcome','code','acceptedInputNo','decidedAtServerTick','revision','duplicate'])
  &&d.commandSeq===command.commandSeq&&d.type===command.type&&d.executeTick===command.executeTick&&d.clockEpoch===before.clockEpoch
  &&d.outcome==='accepted'&&d.code===null&&d.duplicate===false&&d.acceptedInputNo===next.acceptedInputNo&&d.revision===next.revision
  &&safeInteger(d.decidedAtServerTick,0,profile.serverMaxTick)&&safeInteger(a.serverTick,d.decidedAtServerTick,profile.serverMaxTick)&&d.executeTick<=d.decidedAtServerTick+1&&d.executeTick>a.committedThroughTick,'decision is missing, rejected, duplicated or mismatched');
 inputProof(after.status!=='fault'&&after.game?.status!=='fault'&&after.game?.phase!=='fault','accepted input entered game fault');
 return Object.freeze({protocol:profile.protocol,ruleVersion:profile.ruleVersion,...(profile.profileId?{profileId:profile.profileId}:{}),requestId:request.request_id,roomId:before.roomId,playerKey:before.playerKey,clockEpoch:before.clockEpoch,
  commandSeq:command.commandSeq,type:command.type,executeTick:command.executeTick,acceptedInputNoBefore:before.acceptedInputNo,acceptedInputNoAfter:next.acceptedInputNo,
  revision:next.revision,decidedAtServerTick:d.decidedAtServerTick});
}

export async function playOneArenaAction(frame, game, readRoom, {touch=false,timeoutMs=LIMIT_MS,deadlineAt=Infinity,signal,beforeAction=()=>{}}={}) {
  if (!GAMES.has(game)) throw new Error(`Unsupported arena game: ${game}`);
  if (typeof frame?.page !== 'function' || typeof frame?.locator !== 'function') {
    throw new Error('An actual Playwright Frame is required, not a FrameLocator');
  }
  if (typeof readRoom !== 'function') throw new Error('readRoom must return the latest room snapshot');
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('timeoutMs must be positive');
  const page = frame.page(), deadline = Math.min(Date.now()+timeoutMs,deadlineAt), uiSteps = [];
  const stopped=code=>Object.assign(new Error(`${game}: ${code}`),{code});
  let roomId, lastReason = 'waiting for an active room';
  const remaining = () => {
    if(signal?.aborted)throw stopped('ACTION_ABORTED');
    const value = deadline - Date.now();
    if (value <= 0) throw Object.assign(new Error(`${game}: action deadline exceeded (${lastReason})`),{code:'ACTION_DEADLINE'});
    return value;
  };
  // Never race a UI operation against a timer: it must settle before another
  // driver can act. Locator operations receive remaining() as their timeout.
  const bounded = async operation => {
    const waitMs=remaining();let timer,onAbort;
    try{return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(stopped('ACTION_DEADLINE')),waitMs);if(signal){onAbort=()=>reject(stopped('ACTION_ABORTED'));signal.addEventListener('abort',onAbort,{once:true});}})]);}
    finally{clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
  };
  const ui = async operation => { remaining(); await beforeAction(); remaining(); return await operation(); };
  const releasePointer = async () => {
    // Release is mandatory cleanup of an already-started atomic gesture. Drain
    // it even if a deadline/identity guard trips; never leave a held pointer or
    // an asynchronous input behind. The caller records any deadline overrun.
    let stopError;try{remaining();await beforeAction();}catch(e){stopError=e;}
    await page.mouse.up();if(stopError)throw stopError;
  };
  const pause = async ms => {
    await new Promise(resolve => setTimeout(resolve, Math.min(ms, remaining())));
    remaining();
  };
  const locator = selector => frame.locator(selector);
  const testId = id => locator(attr('data-testid', id));
  const usable = async target => await bounded(()=>target.isVisible()) && await bounded(()=>target.isEnabled());
  const click = async (target, description, options = {}) => {
    lastReason = description;
    await ui(()=>target[touch?'tap':'click']({ ...options, timeout: remaining() }));
    uiSteps.push(description);
  };
  const bounds = async target => {
    await ui(()=>target.scrollIntoViewIfNeeded({ timeout: remaining() }));
    const box = await bounded(()=>target.boundingBox({ timeout: remaining() }));
    if (!box || box.width <= 0 || box.height <= 0) throw new Error(`${game}: missing visible input bounds`);
    return box;
  };
  const ownTurn = room => room.game.turnKey === room.me;
  const notBusy = room => Number(room.server_now) >= Number(room.game.busyUntil || 0);
  const buttonPlan = async (id, type) => {
    const target = testId(id);
    return await usable(target) ? { type, run: () => click(target, `click ${id}`) } : null;
  };

  async function selectPlan(room) {
    const g = room.game;
    switch (game) {
      case 'towerlink': {
        const action = g.legalActions?.find(action => action.type === 'link'
          && Number.isInteger(action.from) && Number.isInteger(action.to)
          && g.towers?.find(tower => tower.id === action.from)?.troops > 5);
        if (!action) return null;
        const from = locator(attr('data-tower', action.from)), to = locator(attr('data-tower', action.to));
        if (!await usable(from) || !await usable(to)) return null;
        return { type: 'link', run: async () => {
          lastReason = `drag standing route ${action.from} to ${action.to}`;
          const start = await bounds(from), end = await bounds(to);
          await ui(()=>page.mouse.move(start.x + start.width / 2, start.y + start.height / 2));
          await ui(()=>page.mouse.down());
          try {
            await ui(()=>page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 }));
          } finally { await releasePointer(); }
          uiSteps.push(`drag owned tower ${action.from} to adjacent tower ${action.to}`);
        } };
      }
      case 'golf': return buttonPlan('golf-shoot', 'shot');
      case 'bowling': return buttonPlan('bowling-roll', 'roll');
      case 'run': return buttonPlan('run-jump', 'jump');
      case 'carrom': {
        const ready = await buttonPlan('carrom-shoot', 'shot');
        if (ready) return ready;
        // A later ball position may block the default striker position. Move
        // the real range thumb to a public-board legal offset, then re-check UI.
        const track = locator('.oc-position-track input[type="range"]');
        if (ownTurn(room) && g.phase === 'aiming' && g.me && await usable(track)) {
          const offset = nearestLegalOffset(g.coins, g.me.seatIndex, g.players.length);
          if (offset === null) throw new Error('carrom: no legal striker placement');
          const box = await bounds(track);
          await click(track, 'adjust carrom striker on visible range', {
            position: { x: Math.max(1, Math.min(box.width - 1, (offset + 1) * box.width / 2)), y: box.height / 2 },
          });
        }
        return null;
      }
      case 'match': {
        if (!Array.isArray(g.board) || g.board.length !== 36 || !notBusy(room)) return null;
        const action = matchLegalMoves(g.board)[0];
        if (!action) throw new Error('match: public board has no legal swap');
        const from = locator(`.match-cells ${attr('data-cell', action.from)}`);
        const to = locator(`.match-cells ${attr('data-cell', action.to)}`);
        if (!await usable(from) || !await usable(to)) return null;
        return { type: 'swap', run: async () => {
          // A previously selected tile must not convert our first click into
          // an unintended swap. Deselect it using the same public UI first.
          const selected = locator('.match-cells button[aria-pressed="true"]');
          if (await bounded(()=>selected.count())) await click(selected, 'deselect previous match tile');
          await click(from, `select match cell ${action.from}`);
          await click(to, `swap adjacent match cell ${action.to}`);
        } };
      }
      case 'ludo': {
        if (!ownTurn(room)) return null;
        const legal = g.legalActions || [], roll = locator('[data-action="ludo-roll"]');
        if (legal.some(a => a.type === 'roll') && await usable(roll)) {
          return { type: 'roll', run: () => click(roll, 'click ludo dice') };
        }
        const move = legal.find(a => a.type === 'move');
        if (!move || !notBusy(room)) return null;
        const pawn = locator(attr('data-pawn', `${room.me}:${move.piece}`));
        if (!await usable(pawn)) return null;
        return { type: 'move', run: async () => {
          await click(pawn, `select legal ludo pawn ${move.piece}`);
          await click(locator('[data-action="ludo-move"]'), 'confirm ludo move');
        } };
      }
      case 'jackaroo': {
        if (!notBusy(room)) return null;
        const exchange = g.phase === 'exchange';
        if (exchange && g.passSubmitted || !exchange && !ownTurn(room)) return null;
        const action = exchange ? g.hand?.[0] && { type: 'pass', cardId: g.hand[0].id }
          : [...(g.legalActions || [])].sort((a, b) => Number(a.effect === 'split') - Number(b.effect === 'split'))[0];
        if (!action) return null;
        const card = locator(attr('data-card', action.cardId));
        if (!await usable(card)) return null;
        return { type: action.type, run: async () => {
          await click(card, 'select observed legal jackaroo card');
          if (!exchange) {
            const effect = action.type === 'discard' ? 'discard' : action.effect === 'move' ? `move:${action.steps}` : action.effect;
            await click(locator(attr('data-effect', effect)), `select jackaroo ${effect} effect`);
            if (action.effect === 'split') {
              for (const segment of action.segments) {
                await click(locator(attr('data-marble', segment.pieceId)), 'select legal jackaroo split marble');
                await click(locator(attr('data-split-step', segment.steps)), `choose ${segment.steps} split steps`);
              }
            } else if (action.pieceId !== undefined) {
              await click(locator(attr('data-marble', action.pieceId)), 'select legal jackaroo marble');
              if (action.targetId !== undefined) await click(locator(attr('data-marble', action.targetId)), 'select legal jackaroo swap target');
            }
          }
          await click(locator('[data-action="jack-confirm"]'), 'confirm jackaroo action');
        } };
      }
      case 'domino': {
        if (!ownTurn(room) || !notBusy(room)) return null;
        const move = g.legalMoves?.[0];
        if (move) {
          const tile = testId(`domino-tile-${move.tileId}`);
          if (!await usable(tile)) return null;
          if (!['left', 'right'].includes(move.end)) throw new Error('domino: unrecognized legal endpoint');
          return { type: 'play', run: async () => {
            if (await bounded(()=>tile.getAttribute('aria-pressed', { timeout: remaining() })) !== 'true') {
              await click(tile, 'select legal domino tile');
            }
            await click(testId(`domino-${move.end}`), `play domino ${move.end} end`);
          } };
        }
        if (g.canDraw) return buttonPlan('domino-draw', 'draw');
        if (g.canPass) return buttonPlan('domino-pass', 'pass');
        return null;
      }
      case 'pool': {
        if (!ownTurn(room) || g.phase !== 'aiming') return null;
        const ready = await buttonPlan('pool-shoot', 'shot');
        if (ready) return ready;
        const board = testId('pool-board');
        if (!await usable(board)) return null;
        const point = g.ballInHand && !g.cuePlaced ? cueDefault(g.balls)
          : g.eightEligible && g.calledPocket === null ? POCKETS[0] : null;
        if (!point) return null;
        const type = g.ballInHand && !g.cuePlaced ? 'place' : 'call';
        return { type, run: async () => {
          const box = await bounds(board);
          // Inverse of createPoolTable.point(), using the canvas' measured
          // rectangle and the source's 8.1 x 14.8 table projection.
          await click(board, `pool ${type} at legal table position`, {
            position: { x: (point.x / 8.1 + .5) * box.width, y: (point.y / 14.8 + .5) * box.height },
          });
        } };
      }
      case 'darts': {
        if (!ownTurn(room) || !notBusy(room)) return null;
        const board = locator('svg.da-board[role="application"]');
        if (!await usable(board)) return null;
        return { type: 'throw', run: async () => {
          lastReason = 'drag darts board and release';
          const box = await bounds(board), x = box.x + box.width / 2;
          const screenY = normalized => box.y + (.5 + normalized / 2.5) * box.height;
          await ui(()=>page.mouse.move(x, screenY(.25)));
          await ui(()=>page.mouse.down());
          try {
            // Five samples over ~400 ms meet the actual mapGesture duration,
            // distance and speed constraints. Coordinates follow DartBoard.point.
            for (let i = 1; i <= 4; i++) {
              await pause(100);
              await ui(()=>page.mouse.move(x, screenY(.25 - .22 * i / 4)));
            }
          } finally { await releasePointer(); }
          uiSteps.push('hold SVG center, drag upward 0.22 board units over 400ms, release');
        } };
      }
    }
  }

  let room, plan;
  while (!plan) {
    remaining();
    room = await bounded(()=>Promise.resolve().then(readRoom));
    if (room) {
      if (room.game_id !== game) throw new Error(`${game}: readRoom returned a different game`);
      if (roomId && room.id !== roomId) throw new Error(`${game}: room changed while waiting for input`);
      roomId = room.id;
      if (!roomId || !Number.isSafeInteger(room.me_last_seq) || typeof room.me !== 'string') {
        throw new Error(`${game}: incomplete personal room snapshot`);
      }
      if (['settled', 'voided', 'cancelled', 'fault', 'settling', 'refunding'].includes(room.status)) {
        throw new Error(`${game}: room is ${room.status}, no legal action can be proved`);
      }
      if (room.status === 'active' && room.game) {
        const mine = room.game.me&&typeof room.game.me==='object'?room.game.me:room.game.players?.find?.(p => p.key === room.me);
        if (room.game.forfeited || mine?.forfeited || mine?.completed || mine?.eliminated || mine?.finishTick!=null || room.game.status === 'finished') {
          throw new Error(`${game}: player/game has already finished or forfeited`);
        }
        lastReason = 'waiting for own turn and an enabled legal control';
        plan = await selectPlan(room);
      }
    }
    if (!plan) await pause(150);
  }

  const inputBaseline=game==='run'?runPracticeInputBaseline(room):null;
  const seq = inputBaseline?.commandSeq??room.me_last_seq, path = `/api/pvp/rooms/${room.id}/${inputBaseline?'inputs':'action'}`;
  let resolveResponse, responseTimer;
  const responsePromise = new Promise(resolve => { resolveResponse = resolve; });
  const onResponse = response => {
    const request = response.request();
    if (request.method() === 'POST' && new URL(response.url()).pathname === path && request.frame() === frame) {
      resolveResponse({ response });
    }
  };
  page.on('response', onResponse);
  responseTimer = setTimeout(() => resolveResponse({ timeout: true }), remaining());
  try {
    await plan.run();
    lastReason = 'waiting for accepted UI action response';
    const captured = await bounded(()=>responsePromise);
    if (captured.timeout) throw Object.assign(new Error(`${game}: no action response before deadline`),{code:'ACTION_DEADLINE'});
    const response = captured.response, requestBody = response.request().postDataJSON();
    if (!inputBaseline&&(requestBody?.seq !== seq + 1 || requestBody?.action?.type !== plan.type)) {
      throw new Error(`${game}: UI submitted an unexpected action or sequence`);
    }
    const status = response.status();
    if (status < 200 || status >= 300) {
      // Keep the authoritative error body on the thrown error.  A WebView
      // action can be rejected after the button was enabled (for example when
      // the observed race tick crosses the server's freshness window); the
      // status alone is not enough to tell a stale-input rejection from a
      // legitimate busy/rate-limit response.
      let body = null;
      try { body = await bounded(()=>response.json()); } catch(error) { if(['ACTION_DEADLINE','ACTION_ABORTED'].includes(error.code))throw error; }
      const error = Object.assign(new Error(`${game}: UI action rejected with HTTP ${status}`), {
        status,
        code: body?.error?.code || body?.code || null,
        responseBody: body,
        requestBody,
      });
      throw error;
    }
    const body = await bounded(()=>response.json()), after = body.room || body;
    let inputEvidence=null;
    if(inputBaseline)try{inputEvidence=verifyRunPracticeInputAction(inputBaseline,requestBody,after,{type:plan.type});}catch(error){Object.assign(error,{status,requestBody,responseBody:body});throw error;}
    if (!inputBaseline&&(after.id !== room.id || after.game_id !== game || after.me !== room.me || after.me_last_seq !== seq + 1)) {
      throw new Error(`${game}: response does not prove exactly one accepted personal action`);
    }
    if (after.status === 'fault' || after.game?.phase === 'fault' || after.game?.status === 'fault') {
      throw new Error(`${game}: accepted action entered a game fault`);
    }
    let towerEvidence;
    if (game === 'towerlink') {
      const { from, to } = requestBody.action;
      if (!after.game?.orders?.some(order => order.ownerKey === room.me && order.from === from && order.to === to)) {
        throw new Error('towerlink: accepted drag did not create a persistent server order');
      }
      lastReason = 'waiting for authoritative troops to depart on the standing route';
      let snapshot = after, army;
      while (!(army = snapshot.game?.armies?.find(unit => unit.ownerKey === room.me && unit.from === from && unit.to === to && unit.count > 0))) {
        await pause(100);
        snapshot = await bounded(()=>Promise.resolve().then(readRoom));
        if (!snapshot || snapshot.id !== room.id || ['fault', 'voided', 'cancelled'].includes(snapshot.status)) {
          throw new Error('towerlink: route lost before marching troops could be verified');
        }
        if (snapshot.game?.status === 'finished') throw new Error('towerlink: game ended before marching troops were observed');
      }
      towerEvidence = { ruleVersion: snapshot.game.ruleVersion, from, to, standingOrder: true,
        army: { id: army.id, count: army.count, departedAt: army.departedAt, arrivesAt: army.arrivesAt },
        observedAt: snapshot.server_now };
    }
    return {
      game, roomId: room.id, actionType: plan.type, sequenceBefore: seq,
      sequenceAfter: inputEvidence?.commandSeq??after.me_last_seq, httpStatus: status, uiSteps,
      ...(inputEvidence?{protocol:inputEvidence.protocol,inputEvidence}:{}),
      ...(towerEvidence ? { towerEvidence } : {}),
    };
  } finally {
    clearTimeout(responseTimer);
    page.off('response', onResponse);
  }
}
