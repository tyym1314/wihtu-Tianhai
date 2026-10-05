import {BlockList,isIP} from 'node:net';

const loopbacks=new BlockList();
loopbacks.addSubnet('127.0.0.0',8,'ipv4');
loopbacks.addAddress('::1','ipv6');

// Nginx must overwrite X-Real-IP with $remote_addr. Never trust a public peer
// or infer trust merely from the presence of a forwarding header.
export function clientAddress(req,{trustLoopbackProxy=process.env.OASIS_TRUST_LOOPBACK_PROXY==='1'}={}){
  const peer=req.socket?.remoteAddress||'';
  const family=isIP(peer);
  if(!trustLoopbackProxy||!family||!loopbacks.check(peer,family===6?'ipv6':'ipv4'))return peer;
  const forwarded=req.headers?.['x-real-ip'];
  // Accept a single literal only, never a list, port, hostname or scoped IPv6.
  if(typeof forwarded!=='string'||forwarded.includes('%')||!isIP(forwarded))return peer;
  return forwarded;
}

export function adminSessionCookie(token,publicOrigin,maxAge=28800){
  return `oasis_admin=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${publicOrigin.startsWith('https://')?'; Secure':''}`;
}
