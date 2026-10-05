/** A presentation clock only; authoritative game state and deadlines stay on the server. */
export function createTowerClock(serverAt, localAt) {
  let value=serverAt,lastLocal=localAt,targetOffset=serverAt-localAt;
  let latestServerAt=serverAt,lastReceipt=localAt;
  const now=local=>{
    const elapsed=Math.max(0,local-lastLocal);
    if(!elapsed)return value;
    // Correct clock error by changing playback speed slightly, never by moving
    // time backwards and then making the renderer wait for it to catch up.
    const error=local+targetOffset-(value+elapsed),limit=elapsed*.1;
    value+=elapsed+Math.max(-limit,Math.min(limit,error));
    lastLocal=local;
    return value;
  };
  return {
    now,
    receive(serverTime,simulationAt,local){
      if(!Number.isFinite(serverTime)||serverTime<latestServerAt)return false;
      now(local);
      targetOffset=serverTime-local;
      // A new snapshot may already be ahead of the estimated clock. Rebase
      // once to its confirmed simulation time so following frames keep moving.
      // Countdown snapshots initialize simulationAt in the future; they must
      // not advance the UI past the actual server clock and skip the countdown.
      if(Number.isFinite(simulationAt))value=Math.max(value,Math.min(simulationAt,serverTime));
      latestServerAt=serverTime;lastReceipt=local;
      return true;
    },
    get serverAt(){return latestServerAt;},
    get lastReceipt(){return lastReceipt;},
  };
}
