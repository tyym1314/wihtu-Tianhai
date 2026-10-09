import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const script=await readFile(process.argv[2],'utf8');
const cases=[
 ['game delegates without native exit',{},'handled',1],
 ['lobby requests local Activity close',{result:false},'close',1],
 ['void bridge does not pretend delegation',{result:undefined},'close',1],
 ['missing bridge',{missing:true},'close',0],
 ['bridge exception',{throws:true},'close',1],
 ['wrong origin',{origin:'https://evil.invalid'},'close',0],
 ['wrong path',{pathname:'/demo/native/run'},'close',0],
 ['wrong App',{search:'?app_id=other'},'close',0],
 ['duplicate App',{search:'?app_id=fixture_app_01&app_id=fixture_app_01'},'close',0],
 ['extra token query',{search:'?app_id=fixture_app_01&token=fixture'},'close',0],
 ['host fragment',{hash:'#frame'},'close',0],
 ['subframe cannot invoke native presentation bridge',{subframe:true},'close',0],
];
const results=[];
for(const[label,options,expected,expectedCalls]of cases){
 let calls=0;
 const window={};window.top=options.subframe?{}:window;
 if(!options.missing)window.OasisPlayerHost={requestBack(){calls++;if(options.throws)throw Error('fixture');return Object.hasOwn(options,'result')?options.result:true;}};
 const location={origin:'https://apk-contract.invalid',pathname:'/player',search:'?app_id=fixture_app_01',hash:'',...options};
 const value=vm.runInNewContext(script,{window,location},{timeout:100});
 assert.equal(value,expected,label);assert.equal(calls,expectedCalls,label);
 results.push({case:label,result:value,calls});
}
console.log(JSON.stringify({passed:true,checks:results.length,results}));
