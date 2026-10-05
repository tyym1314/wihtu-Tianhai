import test from 'node:test';
import assert from 'node:assert/strict';
import {workloadCompleted,evaluateMobileCapacity} from '../scripts/benchmark-evaluation.mjs';

const fixture=()=>({completed:true,durationSeconds:900,actualDurationMs:900000,unexpectedErrors:0,httpRequests:100000,
 internal:{duration_ms:900020,routes:[{route:'POST /api/pvp/rooms/:id/action',count:10000,p50_ms:10,p95_ms:90,p99_ms:200,max_ms:400}],
 event_loop:{count:89000,p95_ms:10,p99_ms:20,max_ms:80},cpu:{logical_cpus:8,average_percent_of_one_core:20,average_percent_of_machine:2.5,peak_1s_percent_of_one_core:80,peak_1s_percent_of_machine:10}}});
const verdict=modify=>{const data=fixture();modify?.(data);return evaluateMobileCapacity(data);};

test('full measured workload with complete finite evidence passes',()=>{assert(workloadCompleted(fixture()));assert.equal(verdict().status,'pass');assert.deepEqual(verdict().reasons,[]);});
test('evaluation retains the existing v1 scope and threshold fields',()=>{const v=verdict();assert.equal(v.duration_minimum_seconds,900);assert.equal(v.internal_p95_limit_ms,100);assert.equal(v.internal_p99_limit_ms,250);assert.equal(v.event_loop_p99_limit_ms,50);assert.equal(v.cpu_limit_percent_of_machine,70);assert.match(v.scope,/not public server or physical-phone acceptance/);});
test('a normally finished short smoke is insufficient',()=>{const f=fixture();Object.assign(f,{durationSeconds:5,actualDurationMs:5001});f.internal.duration_ms=5020;assert(workloadCompleted(f));assert.equal(evaluateMobileCapacity(f).status,'insufficient');});
test('configured 900 seconds never substitutes for actual duration',()=>{const f=fixture();f.actualDurationMs=899999.99;assert.equal(workloadCompleted(f),false);assert.equal(evaluateMobileCapacity(f).status,'fail');});
test('configured longer workload cannot pass by reaching only the 900 second standard',()=>{assert.equal(verdict(f=>f.durationSeconds=1800).status,'fail');});
test('actual duration must exclude drain; longer internal window cannot rescue a short scheduler run',()=>{assert.equal(verdict(f=>{f.actualDurationMs=899000;f.internal.duration_ms=916000;}).status,'fail');});
for(const field of ['clientError','roomRestartError','failure'])test(field+' prevents both completion and pass even after clean financial drain',()=>{const f=fixture();f[field]={code:'FAILED'};assert.equal(workloadCompleted(f),false);assert.equal(evaluateMobileCapacity(f).status,'fail');});
for(const completed of [false,undefined,null,1,'true'])test('completion must be literal true: '+String(completed),()=>{const f=fixture();f.completed=completed;assert.equal(workloadCompleted(f),false);assert.equal(evaluateMobileCapacity(f).status,'fail');});
for(const value of [undefined,null,NaN,Infinity,-1,'900'])test('configured duration rejects missing or invalid values: '+String(value),()=>{const f=fixture();f.durationSeconds=value;assert.equal(workloadCompleted(f),false);assert.equal(evaluateMobileCapacity(f).status,'fail');});
for(const value of [undefined,null,NaN,Infinity,-1,'900000'])test('actual duration rejects missing or invalid values: '+String(value),()=>{const f=fixture();f.actualDurationMs=value;assert.equal(workloadCompleted(f),false);assert.equal(evaluateMobileCapacity(f).status,'fail');});
test('zero configured duration cannot prove completion',()=>{const f=fixture();f.durationSeconds=0;assert.equal(workloadCompleted(f),false);assert.equal(evaluateMobileCapacity(f).status,'fail');});
test('undefined input cannot pass vacuous checks',()=>{assert.equal(workloadCompleted(),false);assert.equal(evaluateMobileCapacity().status,'fail');});
for(const [label,modify]of [
 ['missing internal',f=>delete f.internal],['null internal',f=>f.internal=null],
 ['missing internal duration',f=>delete f.internal.duration_ms],['null internal duration',f=>f.internal.duration_ms=null],
 ['short internal duration',f=>f.internal.duration_ms=899999],['zero internal duration',f=>f.internal.duration_ms=0],
 ['missing routes',f=>delete f.internal.routes],['null routes',f=>f.internal.routes=null],['empty routes',f=>f.internal.routes=[]],
 ['missing route name',f=>delete f.internal.routes[0].route],['empty route name',f=>f.internal.routes[0].route=''],
 ['zero route count',f=>f.internal.routes[0].count=0],['missing route count',f=>delete f.internal.routes[0].count],
 ['missing route p50',f=>delete f.internal.routes[0].p50_ms],['missing route p95',f=>delete f.internal.routes[0].p95_ms],
 ['null route p99',f=>f.internal.routes[0].p99_ms=null],['missing route max',f=>delete f.internal.routes[0].max_ms],
 ['missing event loop',f=>delete f.internal.event_loop],['zero loop count',f=>f.internal.event_loop.count=0],
 ['missing loop count',f=>delete f.internal.event_loop.count],['missing loop p99',f=>delete f.internal.event_loop.p99_ms],
 ['missing cpu',f=>delete f.internal.cpu],['missing peak CPU',f=>delete f.internal.cpu.peak_1s_percent_of_machine],
 ['missing logical CPUs',f=>delete f.internal.cpu.logical_cpus],['zero logical CPUs',f=>f.internal.cpu.logical_cpus=0],
 ['no HTTP requests',f=>f.httpRequests=0],['missing HTTP requests',f=>delete f.httpRequests],['missing error count',f=>delete f.unexpectedErrors],
 ])test(label+' is insufficient, never coerced to zero or pass',()=>{assert.equal(verdict(modify).status,'insufficient');});
for(const [label,modify]of [
 ['invalid internal type',f=>f.internal=[]],['invalid routes type',f=>f.internal.routes={}],['invalid route entry',f=>f.internal.routes=[42]],
 ['invalid route name',f=>f.internal.routes[0].route=3],['negative route count',f=>f.internal.routes[0].count=-1],
 ['fractional route count',f=>f.internal.routes[0].count=.5],['unsafe route count',f=>f.internal.routes[0].count=Number.MAX_SAFE_INTEGER+1],
 ['invalid loop type',f=>f.internal.event_loop=''],['invalid CPU type',f=>f.internal.cpu=[]],
 ['fractional logical CPU count',f=>f.internal.cpu.logical_cpus=1.5],['negative error count',f=>f.unexpectedErrors=-1],
 ['errors greater than requests',f=>{f.unexpectedErrors=11;f.httpRequests=10;}],
 ['fractional requests',f=>f.httpRequests=1.5],['fractional errors',f=>f.unexpectedErrors=.5],
 ['out-of-order route percentiles',f=>f.internal.routes[0].p95_ms=9],
 ['out-of-order event-loop percentiles',f=>f.internal.event_loop.p95_ms=21],
 ])test(label+' fails malformed measurements',()=>{assert.equal(verdict(modify).status,'fail');});
for(const value of [NaN,Infinity,-1,'10'])for(const [label,modify]of [
 ['route p95',f=>f.internal.routes[0].p95_ms=value],['internal duration',f=>f.internal.duration_ms=value],
 ['loop count',f=>f.internal.event_loop.count=value],['CPU peak',f=>f.internal.cpu.peak_1s_percent_of_machine=value],
 ['HTTP requests',f=>f.httpRequests=value],['error count',f=>f.unexpectedErrors=value],
 ])test(label+' rejects invalid numeric sample '+String(value),()=>{assert.equal(verdict(modify).status,'fail');});
test('inclusive route and loop latency boundaries pass',()=>{assert.equal(verdict(f=>{f.internal.routes[0].p95_ms=100;f.internal.routes[0].p99_ms=250;f.internal.event_loop.p99_ms=50;}).status,'pass');});
for(const [label,modify]of [['route p95',f=>f.internal.routes[0].p95_ms=100.01],['route p99',f=>f.internal.routes[0].p99_ms=250.01],['loop p99',f=>f.internal.event_loop.p99_ms=50.01],['CPU strict boundary',f=>f.internal.cpu.peak_1s_percent_of_machine=70],['error rate strict boundary',f=>f.unexpectedErrors=100]])test(label+' at/over forbidden limit fails',()=>{assert.equal(verdict(modify).status,'fail');});
test('error rate below 0.1 percent remains allowed by v1 (not the legacy zero-error gate)',()=>{assert.equal(verdict(f=>f.unexpectedErrors=99).status,'pass');});
test('failure takes precedence over simultaneous missing evidence',()=>{const v=verdict(f=>{delete f.internal.cpu;f.internal.routes[0].p99_ms=251;});assert.equal(v.status,'fail');assert(v.reasons.some(r=>r.endsWith(':over-limit')));assert(v.reasons.some(r=>r.endsWith(':missing')));});
test('normally completed short sample with a measured violation still fails',()=>{assert.equal(verdict(f=>{f.durationSeconds=5;f.actualDurationMs=5000;f.internal.duration_ms=5000;f.internal.event_loop.p99_ms=51;}).status,'fail');});
test('evaluation is deterministic and does not mutate input evidence',()=>{const f=fixture(),before=structuredClone(f);const a=evaluateMobileCapacity(f),b=evaluateMobileCapacity(f);assert.deepEqual(a,b);assert.deepEqual(f,before);});

test('required individual games cannot use a passing aggregate as evidence',()=>{const f=fixture();f.requiredGames=['bowling'];assert.equal(evaluateMobileCapacity(f).status,'insufficient');});
const taggedFixture=()=>{const f=fixture();f.requiredGames=['run','bowling','towerlink','thunder','tiger'];f.internal.game_routes=f.requiredGames.map(game=>({...f.internal.routes[0],game,route:['thunder','tiger'].includes(game)?`POST /api/play/${game}/spin`:'POST /api/pvp/rooms/:id/action'}));return f;};
test('all required game actions with complete histograms pass',()=>{assert.equal(evaluateMobileCapacity(taggedFixture()).status,'pass');});
test('Bowling over 100 ms fails even if the combined route is fast',()=>{const f=taggedFixture();f.internal.game_routes.find(r=>r.game==='bowling').p95_ms=167;assert.equal(evaluateMobileCapacity(f).status,'fail');});
test('a missing game action is insufficient even with game GET observations',()=>{const f=taggedFixture();f.internal.game_routes.find(r=>r.game==='bowling').route='GET /api/pvp/rooms/:id';assert.equal(evaluateMobileCapacity(f).status,'insufficient');});
test('tagged zero-count action cannot prove a game passed',()=>{const f=taggedFixture();f.internal.game_routes[0].count=0;assert.equal(evaluateMobileCapacity(f).status,'insufficient');});
test('tagged missing latency cannot be treated as zero',()=>{const f=taggedFixture();delete f.internal.game_routes[0].p95_ms;assert.equal(evaluateMobileCapacity(f).status,'insufficient');});
test('duplicate tagged route cannot satisfy coverage twice',()=>{const f=taggedFixture();f.internal.game_routes.push({...f.internal.game_routes[0]});assert.equal(evaluateMobileCapacity(f).status,'fail');});
for(const requiredGames of [[],['bowling','bowling'],['unknown'],'bowling',null])test('invalid required game set fails '+JSON.stringify(requiredGames),()=>{const f=taggedFixture();f.requiredGames=requiredGames;assert.equal(evaluateMobileCapacity(f).status,'fail');});
