/** Isolated live HTTP/engine fixture. Only the QA bundle adds a read-only renderer observer. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import * as E from '../engine.mjs';

export async function motionReviewServer() {
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  const players=['LINA','OMAR','NOOR','ZAIN'].map((name,seatIndex)=>({key:`p${seatIndex}`,name,seatIndex,isBot:seatIndex>0}));
  let state=E.createState('02'.repeat(32),Date.now(),{players});
  const actions=[], fixtures=[];
  const advance=()=>E.tick(state,Date.now());
  const snap=()=>({id:'isolated-run-motion-v4',game_id:'run',status:state.status==='active'?'active':'settled',practice:true,capacity:4,me:'p0',players:players.map(p=>({external_user_id:p.key,name:p.name,bot:p.isBot,seat_index:p.seatIndex})),entry_minor:'0',prize_minor:'0',server_now:Date.now(),game:E.view(state,'p0')});
  const source=`
    import React,{useState,useEffect,useMemo} from 'react';
    import {createRoot} from 'react-dom/client';
    import Game from './arena/run/RunGame.jsx';
    window.__motionSamples=[]; window.__snapshotReceipts=[];
    window.__observeRun=(key,root,pose,game,time)=>{
      const sprite=root.children.find(c=>c.isSprite), map=sprite?.material?.map;
      const shadow=root.children.find(c=>c.geometry?.type==='CircleGeometry');
      const ring=root.children.find(c=>c.geometry?.type==='TorusGeometry');
      root.updateMatrixWorld(true);
      const worldY=o=>o?o.getWorldPosition(o.position.clone()).y:null;
      window.__motionSamples.push({key,time,snapshotTick:game.snapshotTick,
        authoritativeDistance:game.players.find(p=>p.key===key)?.distance,
        visualDistance:pose.distance,visualHeight:pose.y,clip:root.userData.clip,
        character:root.userData.character,frame:root.userData.frame,
        frameCount:root.userData.runFrameCount,sheet:root.userData.sheet,
        uv:map?.offset.toArray(),repeat:map?.repeat.toArray(),imageSize:[map?.image?.width,map?.image?.height],
        source:map?.source?.data?.currentSrc||map?.source?.data?.src,
        groundShadowHeight:root.userData.groundShadowHeight,
        shadowWorldY:worldY(shadow),ringWorldY:worldY(ring),
        shadowOpacity:shadow?.material.opacity,shadowScale:shadow?.scale.x,
        spriteScale:sprite?.scale.toArray(),visible:root.visible});
      if(window.__motionSamples.length>24000)window.__motionSamples.splice(0,4000);
    };
    function App(){
      const[room,setRoom]=useState(null);
      const audio=useMemo(()=>({enabled:true,play(kind){window.__audio=(window.__audio||[]).concat(kind)},setEnabled(){}}),[]);
      function receive(data){window.__snapshotReceipts.push({at:performance.now(),tick:data.game.snapshotTick});setRoom(data)}
      useEffect(()=>{let stopped=false;async function poll(){try{const data=await(await fetch('/room')).json();if(!stopped)receive(data)}finally{if(!stopped)setTimeout(poll,150)}}poll();return()=>{stopped=true}},[]);
      return room?<Game room={room} me="p0" locale={new URLSearchParams(location.search).get('locale')||'en'} audio={audio} onExit={()=>{}} onAction={async action=>{
        const response=await fetch('/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action)});
        const result=await response.json();if(!response.ok)throw Error(result.error);receive(result.room);return result;
      }}/>:null;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `;
  const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'run-motion-review.jsx',loader:'jsx'},bundle:true,write:false,outdir:'/virtual-run-motion-v4',jsx:'automatic',format:'esm',logLevel:'silent',loader:{'.glb':'file','.webp':'file','.png':'file'},plugins:[{name:'read-only-motion-observation',setup(b){
    b.onResolve({filter:/\.(glb|webp|png)\?url$/},a=>({path:resolve(a.resolveDir,a.path.slice(0,-4))}));
    b.onLoad({filter:/\/run\/scene\.mjs$/},async a=>{
      let source=await readFile(a.path,'utf8');
      const anchor='},v.tick,time*.001);';
      if(source.split(anchor).length!==2)throw Error('Scene observation anchor changed; inspect before updating QA');
      source=source.replace(anchor,anchor+'globalThis.__observeRun?.(p.key,r.root,v,game,time);');
      source=source.replace('renderer.render(scene,camera);','renderer.render(scene,camera);globalThis.__rendererStats={...renderer.info.render};');
      return{contents:source,loader:'js',resolveDir:dirname(a.path)};
    });
  }}]});
  const files=new Map(bundle.outputFiles.map(f=>['/'+basename(f.path),f.contents]));
  const js=basename(bundle.outputFiles.find(f=>f.path.endsWith('.js')).path),css=basename(bundle.outputFiles.find(f=>f.path.endsWith('.css')).path);
  const timer=setInterval(advance,25);
  const server=createServer(async(req,res)=>{try{
    const path=new URL(req.url,'http://local').pathname;
    if(files.has(path)){res.setHeader('content-type',path.endsWith('.webp')?'image/webp':path.endsWith('.png')?'image/png':path.endsWith('.glb')?'model/gltf-binary':path.endsWith('.css')?'text/css':'text/javascript');return res.end(files.get(path));}
    if(path==='/room'){advance();res.setHeader('content-type','application/json');return res.end(JSON.stringify(snap()));}
    if(path==='/action'){
      let body='';for await(const chunk of req)body+=chunk;
      const action=JSON.parse(body),result=E.act(state,'p0',action,Date.now());
      actions.push({action,event:result.event});
      await new Promise(r=>setTimeout(r,55));advance();
      res.setHeader('content-type','application/json');return res.end(JSON.stringify({room:snap(),event:result.event}));
    }
    res.setHeader('content-type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#16383d}#root{max-width:460px;margin:auto}</style><link rel="stylesheet" href="/${css}"><div id="root"></div><script type="module" src="/${js}"></script>`);
  }catch(e){res.statusCode=e.status||500;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:e.message,code:e.code}));}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return{
    origin:`http://127.0.0.1:${server.address().port}`,actions,fixtures,state:()=>state,
    configure(name,fn){advance();fn(state);fixtures.push({name,at:Date.now(),tick:state.tick,players:state.players.map(p=>({key:p.key,distance:p.distanceU/300,lane:p.lane}))});},
    async close(){clearInterval(timer);await new Promise(r=>server.close(r));},
  };
}
