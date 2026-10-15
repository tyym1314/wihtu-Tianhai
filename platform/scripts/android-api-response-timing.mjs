/** Diagnostic-only allowlisted headers from an existing owned API response.
 * No request, body read, authentication/header copy, clock correction or gate.
 */
export function readOwnedArenaSessionResponseTiming({requestUrl,method,frameId,ownedFrameId,origin,response}={}){
 try{
  const expected=new URL('/api/arena/session',origin);
  if(expected.protocol!=='https:'||new URL(origin).origin!==origin||method!=='GET'||!ownedFrameId||frameId!==ownedFrameId||requestUrl!==expected.href||response?.url!==expected.href)return null;
  if(!Number.isInteger(response.status)||response.status<100||response.status>599)return null;
  const headers=response.headers;
  if(!headers||typeof headers!=='object'||Array.isArray(headers))return null;
  const keys=Object.keys(headers);if(keys.length>256)return null;
  const find=name=>{const found=keys.filter(key=>key.toLowerCase()===name);return found.length===1?headers[found[0]]:null;};
  const serverTimingRaw=find('server-timing'),requestId=find('x-oasis-request-id');
  if(typeof serverTimingRaw!=='string'||serverTimingRaw.length>64||typeof requestId!=='string'||!/^[a-f0-9]{32}$/.test(requestId))return null;
  const match=/^app;dur=((?:0|[1-9][0-9]*)\.[0-9]{3})$/.exec(serverTimingRaw);
  if(!match)return null;const appDurationMs=Number(match[1]);if(!Number.isFinite(appDurationMs)||appDurationMs<0)return null;
  return Object.freeze({schema:'owned-arena-session-response-app-timing-v1',path:'/api/arena/session',appDurationMs,serverTimingRaw,requestId,
   source:'Original allowlisted Network.responseReceived headers on the already owned game frame',
   durationScope:'Handler entry through JSON preparation before headers; excludes pre-handler queue, proxy, transfer and client parse',
   diagnosticOnly:true,serverCapacityProof:false});
 }catch{return null;}
}
