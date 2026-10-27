/** Name shown for another player: the host App's display name, else the start of their id. */
export const playerName=(p,max=9)=>{const n=(p?.name||'').trim();return n?(n.length>max?n.slice(0,max-1)+'…':n):String(p?.external_user_id||'').slice(0,max);};
/** One letter for the round badge next to the name. */
export const playerInitial=p=>(Array.from((p?.name||'').trim())[0]||String(p?.external_user_id||'?')[0]||'?').toUpperCase();
