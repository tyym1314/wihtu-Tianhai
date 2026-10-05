/** Single-process request budgets, not player-count or global capacity limits. */
export class RateLimiter {
  constructor({maxBuckets=20000,windowMs=60000,now=Date.now}={}){this.buckets=new Map();this.maxBuckets=maxBuckets;this.windowMs=windowMs;this.now=now;this.nextSweep=0;}
  take(key,limit){
    const now=this.now();
    if(now>=this.nextSweep){for(const [k,b] of this.buckets)if(b.until<=now)this.buckets.delete(k);this.nextSweep=now+10000;}
    let b=this.buckets.get(key);
    if(!b||b.until<=now){if(!b&&this.buckets.size>=this.maxBuckets)return false;b={count:0,until:now+this.windowMs};this.buckets.set(key,b);}
    return ++b.count<=limit;
  }
  retryAfter(key){return Math.max(1,Math.ceil(((this.buckets.get(key)?.until??this.now()+this.windowMs)-this.now())/1000));}
  consume(key,limit){if(!this.take(key,limit))throw Object.assign(new Error('Request rate exceeded; retry the original operation after Retry-After'),{status:429,code:'RATE_LIMITED',retryAfterSeconds:this.retryAfter(key)});}
}

const apiDefaults={PVP_READ:900,PVP_ACTION:720,PVP_ROOM_WRITE:120,PROBABILITY_READ:360,PROBABILITY_WRITE:360,PARTNER_READ:1200,PARTNER_WRITE:1200,AUTH_FAILURE_IP:120,EXCHANGE_IP:1200};
const demoDefaults={DEMO_ANONYMOUS_IP:1200,DEMO_GUEST_API:240,DEMO_GUEST_LAUNCH:40};
function configuration(defaults,env){
  return Object.freeze(Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>{
    const name='OASIS_RATE_'+key+'_PER_MINUTE',raw=env[name],value=raw===undefined?fallback:Number(raw);
    if(raw!==undefined&&(!/^[1-9]\d*$/.test(String(raw))||String(raw).trim()!==String(raw))||!Number.isSafeInteger(value)||value<1||value>1000000)throw new Error('INVALID_RATE_LIMIT_CONFIG: '+name);
    return[key,value];
  })));
}
export const apiRateConfiguration=(env=process.env)=>configuration(apiDefaults,env);
export const demoRateConfiguration=(env=process.env)=>configuration(demoDefaults,env);

export class ApiRateLimits {
  constructor({env=process.env,now=Date.now}={}){
    this.config=apiRateConfiguration(env);
    // Invalid anonymous identities cannot consume the authenticated bucket map.
    this.identities=new RateLimiter({now});this.addresses=new RateLimiter({now});
  }
  ip(address,family,limit){this.addresses.consume(JSON.stringify([family,address]),limit);}
  async authenticate(address,authenticate){
    try{return await authenticate();}
    catch(error){
      // Check valid identities first: one abusive peer behind a shared NAT must
      // not deny already authenticated players. Authentication failures never
      // reach game computation or wallet writes; no token is stored in a bucket.
      if(error.status>=400&&error.status<500&&error.status!==429)this.ip(address,'authentication-failure',this.config.AUTH_FAILURE_IP);
      throw error;
    }
  }
  player(session,family,method,path=''){
    const bucket=family==='pvp'?(method==='GET'?'PVP_READ':method==='POST'&&path.endsWith('/action')?'PVP_ACTION':'PVP_ROOM_WRITE'):(method==='GET'?'PROBABILITY_READ':'PROBABILITY_WRITE');
    this.identities.consume(JSON.stringify([bucket,session.app_id,session.external_user_id]),this.config[bucket]);
  }
  partner(app,method){const bucket=method==='GET'?'PARTNER_READ':'PARTNER_WRITE';this.identities.consume(JSON.stringify([bucket,app.id]),this.config[bucket]);}
}
