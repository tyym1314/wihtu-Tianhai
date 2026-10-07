import test from 'node:test';
import assert from 'node:assert/strict';
import {walletRetryNotDue} from '../server/pvp/retry-time.mjs';

const failedAt=Date.parse('2026-10-07T23:59:59.950Z');
const retryAt=new Date(failedAt+1000);
test('a PostgreSQL Date keeps the full retry delay across a second boundary',()=>{
 // Fifty milliseconds after failure, stringifying the Date has already lost
 // the remaining 950ms. This is the old comparison's deterministic failure.
 assert.equal(Date.parse(retryAt)>failedAt+50,false);
 for(const elapsed of [0,49,50,51,500,999])assert.equal(walletRetryNotDue(retryAt,failedAt+elapsed),true,`retry after only ${elapsed}ms`);
 assert.equal(walletRetryNotDue(retryAt,failedAt+1000),false);
 assert.equal(walletRetryNotDue(retryAt,failedAt+1001),false);
});
test('ISO retry timestamps obey the same millisecond boundary as PostgreSQL Dates',()=>{
 for(const input of [retryAt,retryAt.toISOString(),'2026-10-08T08:00:00.950+08:00']){
  assert.equal(walletRetryNotDue(input,failedAt+999),true);
  assert.equal(walletRetryNotDue(input,failedAt+1000),false);
  assert.equal(walletRetryNotDue(input,failedAt+1001),false);
 }
 assert.equal(retryAt.getTime(),failedAt+1000);
});
