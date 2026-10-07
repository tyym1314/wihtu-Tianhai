/** Test-only timing hooks for the exact scene bundle used by reviewServer. */
export function instrumentRunSceneForQA(input){
 let source=input;
 const replace=(needle,value)=>{
  if(source.split(needle).length!==2)throw Error(`Run scene probe insertion point changed: ${needle.slice(0,50)}`);
  source=source.replace(needle,value);
 };
 replace('function burst(p,kind){',"function burst(p,kind){(window.__runSceneEvents??=[]).push({at:performance.now(),kind});");
 replace('function render(time){if(disposed||document.hidden)return;try{',
  'function render(time){if(disposed||document.hidden)return;const frameBegin=performance.now();try{');
 replace('for(const p of particles){if(p.life<=0)continue;',
  'const beforeParticles=performance.now();for(const p of particles){if(p.life<=0)continue;');
 replace('renderer.compile(scene,camera);warmed=true;',
  'const compileBegin=performance.now();renderer.compile(scene,camera);(window.__runSceneCompiles??=[]).push({at:compileBegin,ms:performance.now()-compileBegin});warmed=true;');
 replace('renderer.render(scene,camera);onFrame(time);',
  'const renderBegin=performance.now();renderer.render(scene,camera);const renderEnd=performance.now();const samples=window.__runSceneSamples??=[];if(samples.length<6000)samples.push({at:time,distance:cameraDistance,prepMs:beforeParticles-frameBegin,particlesMs:renderBegin-beforeParticles,renderMs:renderEnd-renderBegin,frameMs:renderEnd-frameBegin,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,programs:renderer.info.programs.length,gpuTextures:renderer.info.memory.textures,gpuGeometries:renderer.info.memory.geometries,visibleParticles:particles.filter(p=>p.mesh.visible).length,visibleGroups:groups.filter(g=>g.visible).length,visibleDecorations:decorations.filter(d=>d.root.visible).length});onFrame(time);');
 return source;
}
