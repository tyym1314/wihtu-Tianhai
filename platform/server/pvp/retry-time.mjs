// pg returns timestamptz as Date. Date.parse(Date) stringifies it without
// milliseconds, which can make a retry delay expire almost one second early.
export function walletRetryNotDue(nextAttemptAt,now=Date.now()){
 const nextAt=nextAttemptAt instanceof Date?nextAttemptAt.getTime():Date.parse(nextAttemptAt);
 return nextAt>now;
}
