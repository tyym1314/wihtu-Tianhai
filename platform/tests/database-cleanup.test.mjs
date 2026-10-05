import test from 'node:test';
import assert from 'node:assert/strict';
import {dropOwnedTestDatabase} from './database-cleanup.mjs';

const name='oasis_portal_test_0123456789abcdef';
test('cleanup refuses unowned and unsafe databases before issuing any query',async()=>{
 const admin={query:()=>{throw Error('query must not be reached');}};
 await assert.rejects(dropOwnedTestDatabase(admin,name),/successfully created/);
 for(const bad of ['oasis_platform','postgres','oasis_portal_test_abc','oasis_portal_test_0123456789abcdef;DROP DATABASE postgres'])await assert.rejects(dropOwnedTestDatabase(admin,bad,{created:true}),/UNSAFE_TEST_DATABASE_NAME/);
});
test('cleanup waits for connections then drops without FORCE and reads back absence',async()=>{
 const queries=[];let polls=0;
 const admin={query:async sql=>{queries.push(sql);if(sql.includes('current_database'))return{rows:[{name:'postgres'}]};if(sql.includes('pg_stat_activity'))return{rows:++polls===1?[{pid:123,state:'idle',backend_type:'client backend'}]:[]};if(sql.includes('pg_database'))return{rowCount:0};return{};}};
 await dropOwnedTestDatabase(admin,name,{created:true});assert.equal(polls,2);assert(queries.includes(`DROP DATABASE "${name}"`));assert(queries.every(q=>!q.includes('FORCE')));assert(queries.at(-1).includes('pg_database'));
});
test('a live connection or database error fails cleanup without destructive fallback',async()=>{
 const queries=[],admin={query:async sql=>{queries.push(sql);return sql.includes('current_database')?{rows:[{name:'postgres'}]}:{rows:[{pid:456,state:'idle',backend_type:'client backend'}]};}};
 await assert.rejects(dropOwnedTestDatabase(admin,name,{created:true,timeoutMs:25}),/still has connections/);assert(queries.every(q=>!q.startsWith('DROP')));
 const failure=Error('Database transport failure');await assert.rejects(dropOwnedTestDatabase({query:async()=>{throw failure;}},name,{created:true}),e=>e===failure);
});
