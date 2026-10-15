// Monte Carlo RTP for a casino slot: node scripts/casino-slot-sim.mjs <game> [cycles]
import {randomBytes} from 'node:crypto';
import {CASINO_GAMES} from '../shared/casino-games.mjs';
import {slotModel,playSlotCycle} from '../server/casino/slots.mjs';
const [game='olympus',n='200000',mode='normal']=process.argv.slice(2),m=slotModel(CASINO_GAMES[game]),N=Number(n),buy=mode==='buy';
let total=0,hits=0,features=0,max=0,capped=0;const t0=Date.now();
for(let i=0;i<N;i++){const r=playSlotCycle(m,randomBytes(32).toString('hex'),'10000',{buy});total+=r.win_x100;if(r.win_x100>0)hits++;if(r.free_spins>0)features++;if(r.win_x100>max)max=r.win_x100;if(r.capped)capped++;}
console.log(JSON.stringify({game,mode,cycles:N,mean_x:+(total/N/100).toFixed(3),rtp:+(total/N/100/(buy?(CASINO_GAMES[game].slot.buy?.price_x100||10000)/100:1)).toFixed(4),hit_rate:+(hits/N).toFixed(4),feature_rate:+(features/N).toFixed(5),max_x:max/100,capped,ms:Date.now()-t0}));
