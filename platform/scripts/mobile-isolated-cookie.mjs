/** Test-only HTTP localhost alias; production signing and CSRF remain upstream. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';

const aliasPattern=/^oasis_quality_demo_[a-f0-9]{32}$/;
export function createLoopbackCookieIsolation(){
 const name='oasis_quality_demo_'+randomBytes(16).toString('hex');
 return Object.freeze({name,
  requestHeaders(headers){
   const result={...headers};
   if(result.cookie){
    result.cookie=result.cookie.split(';').map(value=>value.trim()).filter(Boolean)
     .filter(value=>{const key=value.split('=',1)[0];return key===name||!(key==='__Host-oasis_demo'||key==='oasis_quality_demo'||key.startsWith('oasis_quality_demo_'));})
     .map(value=>value.startsWith(name+'=')?'__Host-oasis_demo='+value.slice(name.length+1):value).join('; ');
    if(!result.cookie)delete result.cookie;
   }
   return result;
  },
  responseHeaders(headers){
   const result={...headers};
   if(result['set-cookie'])result['set-cookie']=result['set-cookie'].map(value=>value.startsWith('__Host-oasis_demo=')?value.replace(/^__Host-oasis_demo=/,name+'=').replace(/;\s*Secure(?=;|$)/gi,''):value);
   return result;
  }
 });
}

function ownedScope({origin,name}){
 const url=new URL(origin);
 assert.equal(url.origin,origin,'Exact loopback origin required');
 assert.equal(url.protocol,'http:');assert.equal(url.hostname,'localhost');
 assert(Number(url.port)>=1024,'Explicit loopback port required');
 assert.match(name,aliasPattern,'Per-instance cookie alias required');
 return {origin,name,domain:'localhost',path:'/'};
}

/** Call only with a browser context owned by the caller, before closing it. */
export async function clearOwnedLoopbackCookie(context,scope){
 const {origin,...filter}=ownedScope(scope);
 await context.clearCookies(filter);
 const remaining=(await context.cookies(origin)).filter(cookie=>cookie.name===filter.name&&cookie.domain===filter.domain&&cookie.path===filter.path);
 assert.equal(remaining.length,0,'Owned loopback cookie cleanup readback failed');
 return {...filter,cleared:true};
}

export async function withOwnedLoopbackCookie(context,scope,run){
 ownedScope(scope);assert.equal(typeof run,'function');let failure;
 try{return await run();}catch(error){failure=error;throw error;}
 finally{
  try{await clearOwnedLoopbackCookie(context,scope);}
  catch(error){if(failure)throw new AggregateError([failure,error],'Run and owned cookie cleanup failed');throw error;}
 }
}
