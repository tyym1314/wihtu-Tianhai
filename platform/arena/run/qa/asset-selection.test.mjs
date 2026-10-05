import test from 'node:test';
import assert from 'node:assert/strict';
import {selectRunPreloadKinds as select} from '../asset-selection.mjs';

test('selected and recovered rosters load only their distinct renderer characters',()=>{
 assert.deepEqual(select(['fox','cat']),['fox','cat']);
 assert.deepEqual(select(['rabbit','cat','rabbit']),['rabbit','cat']);
 assert.deepEqual(select(['bear','rabbit']),['bear','rabbit']);
});
test('defaults, empty roster and unknown-character fallback remain explicit',()=>{
 assert.deepEqual(select(),['fox','cat','bear','rabbit']);
 assert.deepEqual(select([]),[]);
 assert.deepEqual(select(['unknown',null,'fox']),['fox']);
 assert.throws(()=>select(2),TypeError);
});
