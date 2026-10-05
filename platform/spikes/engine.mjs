export const TICK_RATE = 60;
export const TRACK_LENGTH = 78;
export const OBSTACLES = [16, 31, 47, 63];
const IDS = ['runner-0', 'runner-1', 'runner-2', 'runner-3'];

export class RaceEngine {
  constructor() {
    this.players = IDS.map((id, lane) => ({ id, lane, connected: false, role: 'unclaimed', clientId: null, token: null, lastSeq: 0 }));
    this.epoch = 0;
    this.rejections = {};
    this.reset();
  }
  reset() {
    this.epoch++;
    this.matchId = `graybox-${this.epoch}`;
    this.tick = 0; this.state = 'waiting'; this.winner = null; this.finishers = [];
    for (const p of this.players) Object.assign(p, { z: 0, y: 0, vy: 0, lastJumpTick: -100, lastInputTick: -100, slowUntilTick: 0, hits: 0, resolvedObstacles: [], finishTick: null });
  }
  connect(clientId, token, role, createToken) {
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(clientId)) return { error: 'INVALID_CLIENT' };
    if (!['manual', 'script'].includes(role)) return { error: 'INVALID_ROLE' };
    const existing = this.players.find(p => p.clientId === clientId);
    if (existing) {
      if (typeof token !== 'string' || token !== existing.token) return { error: 'INVALID_RESUME_TOKEN' };
      if (existing.connected) return { error: 'ALREADY_CONNECTED' };
      existing.connected = true;
      return { player: existing, resumed: true };
    }
    const vacant = this.players.find(p => p.clientId === null);
    if (!vacant) return { error: 'ROOM_FULL' };
    Object.assign(vacant, { clientId, token: createToken(), role, connected: true });
    return { player: vacant, resumed: false };
  }
  disconnect(playerId) { const p=this.players.find(p=>p.id===playerId); if(p) p.connected=false; }
  start() {
    if (this.state !== 'waiting' || this.players.some(p=>!p.connected)) return false;
    this.state = 'racing'; return true;
  }
  reject(code) { this.rejections[code]=(this.rejections[code]||0)+1; return { ok:false, code }; }
  input(playerId, msg) {
    const p=this.players.find(p=>p.id===playerId);
    if(!p || !p.connected) return this.reject('NOT_CONNECTED');
    if(!msg || msg.type!=='input' || msg.action!=='jump' || !Number.isSafeInteger(msg.seq) || msg.seq<1 || typeof msg.matchId!=='string' || Object.keys(msg).some(k=>!['type','action','seq','matchId'].includes(k))) return this.reject('INVALID_INPUT');
    if(msg.matchId!==this.matchId) return this.reject('STALE_MATCH');
    if(msg.seq<=p.lastSeq) return this.reject('DUPLICATE_SEQUENCE');
    if(msg.seq>p.lastSeq+100) return this.reject('SEQUENCE_GAP');
    p.lastSeq=msg.seq;
    if(this.state!=='racing' || p.finishTick!==null) return this.reject('NOT_RACING');
    if(this.tick-p.lastInputTick<6) return this.reject('RATE_LIMIT');
    p.lastInputTick=this.tick;
    if(p.y>0.001 || p.vy!==0) return this.reject('ALREADY_JUMPING');
    p.vy=6.7; p.lastJumpTick=this.tick;
    return { ok:true, acceptedTick:this.tick, seq:p.lastSeq };
  }
  step() {
    if(this.state!=='racing') return;
    this.tick++;
    for(const p of this.players) {
      if(p.finishTick!==null) continue;
      const before=p.z;
      const speed=this.tick<p.slowUntilTick ? 2.4 : 6;
      p.z=Math.min(TRACK_LENGTH,p.z+speed/TICK_RATE);
      if(p.vy!==0 || p.y>0) { p.vy-=18/TICK_RATE; p.y=Math.max(0,p.y+p.vy/TICK_RATE); if(p.y===0)p.vy=0; }
      for(let i=0;i<OBSTACLES.length;i++) if(before<OBSTACLES[i] && p.z>=OBSTACLES[i] && !p.resolvedObstacles.includes(i)) {
        p.resolvedObstacles.push(i);
        if(p.y<0.65) { p.hits++; p.slowUntilTick=this.tick+55; }
      }
      if(p.z>=TRACK_LENGTH) { p.finishTick=this.tick; this.finishers.push(p.id); }
    }
    // Same-tick ties use lane index only in this technical spike; not a proposed commercial prize rule.
    if(this.winner===null && this.finishers.length) this.winner=this.finishers[0];
    if(this.players.every(p=>p.finishTick!==null)) this.state='finished';
  }
  snapshot() {
    return { matchId:this.matchId,tick:this.tick,tickRate:TICK_RATE,state:this.state,winner:this.winner,trackLength:TRACK_LENGTH,obstacles:OBSTACLES,players:this.players.map(({token,...p})=>({...p,resolvedObstacles:[...p.resolvedObstacles]})),finishers:[...this.finishers] };
  }
}
