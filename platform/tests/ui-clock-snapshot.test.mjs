import assert from 'node:assert/strict';
import {test} from 'node:test';
import {uiClockChanged} from '../arena/shared/ui-clock.mjs';
import {retainSnapshot} from '../arena/shared/snapshot-equality.mjs';

test('UI clock skips invisible ticks but observes busy, roll, effect and deadline boundaries',()=>{
 const options={deadlines:[20000],boundaries:[580,1450,2200,20000]};
 assert.equal(uiClockChanged(100,150,options),false);
 assert.equal(uiClockChanged(550,600,options),true,'dice unlock must not wait for a whole second');
 assert.equal(uiClockChanged(950,1000,options),true,'visible countdown changes');
 assert.equal(uiClockChanged(1400,1450,options),true,'busy lock releases at its boundary');
 assert.equal(uiClockChanged(2190,2210,options),true,'score/effect expires within the same second');
 assert.equal(uiClockChanged(19999,20000,options),true,'input closes at deadline');
 assert.equal(uiClockChanged(20000,20100,options),false);
 assert.equal(uiClockChanged(2210,2190,options),true,'a corrected authority sample also updates its boundary');
 assert.equal(uiClockChanged(0,50,{deadlines:[undefined],boundaries:[NaN]}),false);
});

test('same JSON board snapshot keeps references; changed coordinates, protection, metadata and options remain visible',()=>{
 const original=[{key:'p0',name:'You',pieces:[{id:'a',progress:7,protected:true}],forfeited:false}];
 assert.equal(retainSnapshot(original,structuredClone(original)),original);
 for(const change of [p=>p[0].pieces[0].progress++,p=>p[0].pieces[0].protected=false,p=>p[0].name='Changed',p=>p[0].forfeited=true,p=>p[0].extra='new']){
  const next=structuredClone(original);change(next);assert.equal(retainSnapshot(original,next),next);
 }
 const legal=[{type:'move',piece:0,to:8}];assert.equal(retainSnapshot(legal,[{type:'move',piece:0,to:9}])[0].to,9);
});
