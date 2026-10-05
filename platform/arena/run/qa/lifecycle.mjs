import {createRunScene} from '../scene.mjs';
import {loadOasisKit,loadStoneTextures,loadOasisBackdrop} from '../environment.mjs';
import {preloadIllustratedRunners} from '../atlas-characters.mjs';
import {resolveRunCourse} from '../courses.mjs';
import * as E from '../engine.mjs';
let scene=null;const players=[{key:'p0',seatIndex:0},{key:'p1',seatIndex:1}],game=E.view(E.createState('00000004'.padEnd(64,'0'),1000,{players}),'p0');
window.runLifecycle={
 errors:[],
 show(){this.hide();scene=createRunScene(document.querySelector('#track'),{course:resolveRunCourse(game),onError:error=>this.errors.push(String(error))});scene.update(game,'p0');},
 hide(){scene?.dispose();scene=null;},
 async sourceListeners(){const kit=await loadOasisKit(),maps=await loadStoneTextures(),background=await loadOasisBackdrop(),atlases=await preloadIllustratedRunners(['fox','cat']),sources=new Set([background,...Object.values(maps),...atlases]);for(const name of ['BridgeSupport','Palm','RockBank','FinishGate'])kit.clone(name).traverse(o=>{if(o.isMesh){sources.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material]){sources.add(m);for(const value of Object.values(m))if(value?.isTexture)sources.add(value);}}});return{objects:sources.size,disposeListeners:[...sources].reduce((sum,o)=>sum+(o._listeners?.dispose?.length||0),0)};},
};
