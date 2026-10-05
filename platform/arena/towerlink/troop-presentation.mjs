/**
 * Interpolate only troops already present in an authoritative snapshot.
 * This never produces troops, changes towers, or decides the match result.
 * Every new snapshot replaces the projection, including projected casualties.
 */
const roadKey = army => `${Math.min(army.from, army.to)}:${Math.max(army.from, army.to)}`;
const position = (army, at) => {
  const progress = (at - army.departedAt) / (army.arrivesAt - army.departedAt);
  return army.from < army.to ? progress : 1 - progress;
};

export function pointOnRoad(a, b, control, progress) {
  const t = Math.max(0, Math.min(1, progress)), u = 1 - t;
  return control
    ? {x:u*u*a.x + 2*u*t*control.x + t*t*b.x, y:u*u*a.y + 2*u*t*control.y + t*t*b.y}
    : {x:a.x + (b.x-a.x)*t, y:a.y + (b.y-a.y)*t};
}

// The server event ID is unavailable before its next snapshot. Match the
// geometric encounter instead, so a confirmed battle does not flash twice.
export function roadBattleEffectKey(event) {
  if (event.type !== 'road-battle' || !Array.isArray(event.edge)) return event.id;
  const [a,b] = [...event.edge].sort((a,b) => a-b);
  return `road:${a}:${b}:${event.at.toFixed(3)}:${event.position.toFixed(8)}`;
}

export function createBattleEffectGate() {
  const seen = new Map();
  return {
    accept(event, now) {
      const key = roadBattleEffectKey(event);
      if (!key || event.at > now || now-event.at >= 1000 || seen.has(key)) return false;
      seen.set(key, event.at);
      for (const [oldKey, at] of seen) if (now-at > 4000) seen.delete(oldKey);
      if (seen.size > 400) seen.delete(seen.keys().next().value);
      return true;
    },
    clear() { seen.clear(); },
  };
}

export function createTroopProjection(snapshot) {
  const simulationAt = Number.isFinite(snapshot.simulationAt) ? snapshot.simulationAt : snapshot.serverNow;
  const initial = (snapshot.armies || []).filter(a => a.count > 0 && a.arrivesAt > a.departedAt).map(a => ({...a}));
  const roads = new Map(), timeline = [];
  for (const army of initial) {
    const key = roadKey(army);
    if (!roads.has(key)) roads.set(key, []);
    roads.get(key).push({...army});
  }
  for (const [edge, packets] of roads) {
    const encounters = new Map();
    for (let i=0; i<packets.length; i++) for (let j=i+1; j<packets.length; j++) {
      const a=packets[i], b=packets[j];
      if (a.ownerKey === b.ownerKey || a.from !== b.to || a.to !== b.from) continue;
      // Both directions use the same road duration, as specified by the
      // public map. This is the server's exact meeting-time formula.
      const duration=a.arrivesAt-a.departedAt, at=(a.departedAt+b.departedAt+duration)/2;
      if (at <= simulationAt || at < Math.max(a.departedAt,b.departedAt) || at > Math.min(a.arrivesAt,b.arrivesAt)) continue;
      const p=position(a,at), key=`${at}:${p.toFixed(8)}`;
      encounters.set(key,{at,position:p});
    }
    for (const meeting of [...encounters.values()].sort((a,b) => a.at-b.at || a.position-b.position)) {
      const contact=packets.filter(a => a.count > 0 && a.departedAt <= meeting.at && a.arrivesAt >= meeting.at && Math.abs(position(a,meeting.at)-meeting.position) < 1e-7);
      const groups=new Map();
      for (const a of contact) groups.set(a.ownerKey,(groups.get(a.ownerKey)||0)+a.count);
      if (groups.size < 2) continue;
      const total=[...groups.values()].reduce((sum,count) => sum+count,0);
      const winner=[...groups].find(([,count]) => count > total-count);
      const ownerKey=winner?.[0] ?? null, survivors=winner ? winner[1]-(total-winner[1]) : 0;
      const allocations=contact.filter(a => a.ownerKey === ownerKey).map(a => ({army:a,exact:survivors*a.count/winner[1]}));
      let assigned=0;
      for (const a of allocations) { a.count=Math.floor(a.exact); assigned+=a.count; }
      allocations.sort((a,b) => (b.exact-b.count)-(a.exact-a.count) || a.army.departedAt-b.army.departedAt || a.army.from-b.army.from || a.army.id.localeCompare(b.army.id));
      for (let i=0; i<survivors-assigned; i++) allocations[i].count++;
      for (const a of contact) a.count=0;
      for (const a of allocations) a.army.count=a.count;
      timeline.push({
        event:{type:'road-battle',at:meeting.at,edge:edge.split(':').map(Number),position:meeting.position,casualties:total-survivors,ownerKey,survivors,participants:[...groups].map(([ownerKey,count]) => ({ownerKey,count}))},
        counts:contact.map(a => ({id:a.id,count:a.count})),
      });
    }
  }
  timeline.sort((a,b) => a.event.at-b.event.at || a.event.edge[0]-b.event.edge[0] || a.event.edge[1]-b.event.edge[1] || a.event.position-b.event.position);
  // Counts and visibility only change at departures, arrivals and encounters.
  // Reuse the presentation between those boundaries instead of cloning every
  // army and replaying the timeline on each animation frame. Positions still
  // use the exact render clock in tower-scene.js. Cache one interval only, so
  // retained results stay immutable and callers can also seek backwards.
  const boundaries=[...new Set([
    ...initial.flatMap(a => [a.departedAt,a.arrivesAt]),
    ...timeline.map(entry => entry.event.at),
  ])].sort((a,b) => a-b);
  let cached=null,cacheFrom=Infinity,cacheUntil=-Infinity;
  return {
    at(now) {
      if(cached && now>=cacheFrom && now<cacheUntil)return cached;
      let low=0,high=boundaries.length;
      while(low<high){const middle=(low+high)>>>1;if(boundaries[middle]<=now)low=middle+1;else high=middle;}
      cacheFrom=low?boundaries[low-1]:-Infinity;
      cacheUntil=boundaries[low]??Infinity;
      const armies=initial.map(a => ({...a})), byId=new Map(armies.map(a => [a.id,a])), collisions=[];
      for (const entry of timeline) {
        if (entry.event.at > now) break;
        for (const {id,count} of entry.counts) byId.get(id).count=count;
        collisions.push(entry.event);
      }
      cached={armies:armies.filter(a => a.count > 0 && a.departedAt <= now && a.arrivesAt > now),collisions};
      return cached;
    },
  };
}

export function projectTroops(snapshot, now) { return createTroopProjection(snapshot).at(now); }
