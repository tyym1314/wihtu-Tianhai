// Server only. Node.js >=22; no dependencies. Never bundle this file with an App or H5.
import {createHash,createHmac,randomBytes} from 'node:crypto';
export function signedHeaders({keyId,secretBase64,direction='partner-to-platform',method,path,rawBody='',requestId,timestamp=String(Math.floor(Date.now()/1000)),nonce=randomBytes(16).toString('hex')}) {
  if(!/^(\/[A-Za-z0-9_-]+)+$/.test(path))throw Error('V1 target must be an unencoded path without a query');
  const digest=createHash('sha256').update(rawBody,'utf8').digest('hex');
  const canonical=['GP-HMAC-SHA256-V1',direction,keyId,timestamp,nonce,requestId,method,path,digest].join('\n');
  const signature=createHmac('sha256',Buffer.from(secretBase64,'base64')).update(canonical,'utf8').digest('hex');
  return {'Content-Type':'application/json','X-GP-Key-Id':keyId,'X-GP-Direction':direction,'X-GP-Timestamp':timestamp,'X-GP-Nonce':nonce,'X-GP-Request-Id':requestId,'X-GP-Signature':'v1='+signature};
}
export function normalizeLocale(locale='en'){const value=locale==='zh'?'zh-CN':locale;if(!['en','ar','zh-CN'].includes(value))throw Error('Supported locales: en, ar, zh-CN (zh alias accepted)');return value;}
export class OasisClient {
  constructor({baseUrl,keyId,secretBase64,scope}) {Object.assign(this,{baseUrl:baseUrl.replace(/\/$/,''),keyId,secretBase64,scope});const u=new URL(this.baseUrl);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)))throw Error('HTTPS required outside loopback sandbox');}
  async request(method,path,body,requestId=body?.request_id||randomBytes(16).toString('hex')) {
    const rawBody=body===undefined?'':JSON.stringify(body),headers=signedHeaders({keyId:this.keyId,secretBase64:this.secretBase64,method,path,rawBody,requestId});
    const response=await fetch(this.baseUrl+path,{method,headers,body:body===undefined?undefined:rawBody,signal:AbortSignal.timeout(5000)}),data=await response.json();
    if(!response.ok){const error=new Error(data.error?.message||data.message||`HTTP ${response.status}`);error.code=data.error?.code||data.code;error.status=response.status;throw error;}return data;
  }
  createSession({requestId,externalUserId,gameId,locale='en',hostPlatform='web',resumeSessionId,hostOrigin}) {
    if(!requestId)throw Error('Persist requestId before sending; retry with the same input');
    return this.request('POST','/v1/sessions',{...this.scope,request_id:requestId,external_user_id:externalUserId,...(gameId?{game_id:gameId}:{}),locale:normalizeLocale(locale),host_platform:hostPlatform,...(hostOrigin?{host_origin:hostOrigin}:{}),...(resumeSessionId?{resume_session_id:resumeSessionId}:{})});
  }
  games(){return this.request('GET','/v1/games');}
  match(matchId){if(!/^[A-Za-z0-9_-]+$/.test(matchId))throw Error('Invalid match ID');return this.request('GET','/v1/matches/'+matchId);}
  operation(operationId){if(!/^[A-Za-z0-9_-]+$/.test(operationId))throw Error('Invalid operation ID');return this.request('GET','/v1/operations/'+operationId);}
}
