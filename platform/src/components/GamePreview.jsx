import React,{useState} from 'react';
import {imageFor} from '../data.js';

export default function GamePreview({game}){
 const [mode,setMode]=useState(game.sample?'screen':'design');
 return <div className="game-preview">
  {game.sample&&<div className="preview-tabs" role="group" aria-label="游戏画面预览">{[['screen','试玩画面'],['design','设计参考'],['motion','动效录屏']].map(([key,label])=><button key={key} className={mode===key?'active':''} aria-pressed={mode===key} onClick={()=>setMode(key)}>{label}</button>)}</div>}
  {mode==='design'?<img className="design-board" src={imageFor(game)} alt={`${game.name}完整设计图`}/>:<div className="playable-preview">{mode==='screen'?<img src={`/previews/${game.id}.png`} alt={`${game.name}手机实玩画面`}/>:<video key={game.id} controls playsInline preload="metadata" poster={`/previews/${game.id}.png`} src={`/previews/${game.id}.webm`} aria-label={`${game.name}实际游戏录屏`}/>}<p>{mode==='screen'?'手机尺寸下的实际游戏画面':'实际操作录屏不含音轨，打开游戏可体验音乐与音效'}</p></div>}
 </div>;
}
