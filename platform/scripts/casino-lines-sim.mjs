// Monte Carlo RTP for lines/ways slots: node scripts/casino-lines-sim.mjs <game> [cycles]
import {randomBytes} from 'node:crypto';
import {CASINO_GAMES} from '../shared/casino-games.mjs';
import {linesModel,playLinesCycle} from '../server/casino/slot-lines.mjs';
const [game,n='200000']=process.argv.slice(2),m=linesModel(CASINO_GAMES[game]),N=Number(n);
let total=0,hits=0,feat=0,max=0,scat=0;const t0=Date.now();
for(let i=0;i<N;i++){const r=playLinesCycle(m,randomBytes(32).toString('hex'),'10000');total+=r.win_x100;if(r.win_x100>0)hits++;if(r.free_spins)feat++;max=Math.max(max,r.win_x100);scat+=r.spins.reduce((a,s)=>a+s.scatter_pay_x100,0);}
const rtp=total/N/100,sr=scat/N/100;
console.log(JSON.stringify({game,cycles:N,rtp:+rtp.toFixed(4),pay_scale_for_target:+((m.targetRtp-sr)/(rtp-sr)).toFixed(3),scatter_rtp:+(scat/N/100).toFixed(4),hit_rate:+(hits/N).toFixed(3),feature_rate:+(feat/N).toFixed(5),max_x:max/100,ms:Date.now()-t0}));
