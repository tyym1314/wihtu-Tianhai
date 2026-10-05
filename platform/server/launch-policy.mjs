/** Exact browser-origin policy. No database access and no secret-bearing state. */
function fail(code,message,status=400){const error=new Error(message);error.code=code;error.status=status;throw error;}
export function normalizeOrigin(value,{allowLoopback=true}={}){
 if(typeof value!=='string'||value.length>256||value!==value.trim())fail('INVALID_ORIGIN','Expected an exact HTTPS origin');
 let url;try{url=new URL(value);}catch{fail('INVALID_ORIGIN','Malformed origin');}
 const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname)||value.includes('*')||value==='null'||url.protocol!=='https:'&&!(allowLoopback&&loopback&&url.protocol==='http:'))fail('INVALID_ORIGIN','Use an exact HTTPS origin, or HTTP loopback for local testing');
 return url.origin;
}
export function normalizeAllowedOrigins(value,platformOrigin){
 const own=normalizeOrigin(platformOrigin);if(value===undefined||value===null)return[own];
 if(!Array.isArray(value)||value.length>20)fail('INVALID_ORIGIN','Provide up to 20 exact host origins');
 return[...new Set([own,...value.map(v=>normalizeOrigin(v))])];
}
export function resolveHostOrigin(requested,allowedOrigins,platformOrigin){const host=normalizeOrigin(requested??platformOrigin),allowed=normalizeAllowedOrigins(allowedOrigins,platformOrigin);if(!allowed.includes(host))fail('HOST_ORIGIN_FORBIDDEN','Host origin is not registered for this App',403);return host;}
export function assertExchangeOrigin(received,sessionHostOrigin,platformOrigin){const expected=normalizeOrigin(sessionHostOrigin??platformOrigin),actual=normalizeOrigin(received??platformOrigin);if(actual!==expected)fail('HOST_ORIGIN_FORBIDDEN','Launch code belongs to a different host origin',403);return actual;}
