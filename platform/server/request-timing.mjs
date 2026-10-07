import {randomBytes} from 'node:crypto';

const pending=new WeakMap();
const roomRead=/^\/api\/pvp\/rooms\/[A-Za-z0-9_-]+$/;

/** Per-request diagnostics contain no room, player, token or caller-supplied ID. */
export function beginRoomReadTiming(req,res,{now=()=>performance.now(),makeId=()=>randomBytes(16).toString('hex')}={}){
 if(req.method!=='GET'||!roomRead.test(req.url||'')||pending.has(res))return false;
 const started=now(),requestId=makeId();
 if(!Number.isFinite(started)||!/^[a-f0-9]{32}$/.test(requestId))return false;
 pending.set(res,{started,requestId,now});
 return true;
}

/** Call after JSON serialization, immediately before headers are committed.
 * app measures handler-entry through response preparation only. It excludes
 * pre-handler event-loop/socket queueing, proxy time, transfer and client parse.
 * The server-generated ID lets controlled clients correlate proxy diagnostics.
 */
export function finishRoomReadTiming(res){
 const state=pending.get(res);
 if(!state)return false;
 pending.delete(res);
 if(res.headersSent||res.destroyed)return false;
 const duration=state.now()-state.started;
 if(!Number.isFinite(duration)||duration<0)return false;
 res.setHeader('X-Oasis-Request-Id',state.requestId);
 res.setHeader('Server-Timing',`app;dur=${duration.toFixed(3)}`);
 return true;
}
