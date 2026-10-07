import React,{useState} from 'react';
import {imageFor} from '../data.js';

export default function GamePreview({game}){
 const media=game.preview||{};
 const [mode,setMode]=useState(media.screen?'screen':'design'),[failed,setFailed]=useState(null),[attempt,setAttempt]=useState(0);
 const tabs=[...(media.screen?[['screen','试玩画面']]:[]),['design','设计参考'],...(media.motion?[['motion','动效录屏']]:[])];
 const select=next=>{setMode(next);setFailed(null);setAttempt(value=>value+1);};
 const unavailable=()=>{setFailed(mode);if(mode!=='design')setMode('design');};
 const label=key=>tabs.find(([value])=>value===key)?.[1]||'预览';
 return <div className="game-preview">
  <div className="preview-tabs" role="group" aria-label="游戏画面预览">{tabs.map(([key,title])=><button type="button" key={key} className={mode===key?'active':''} aria-pressed={mode===key} onClick={()=>select(key)}>{title}</button>)}</div>
  {failed&&<div className="playable-preview" role="status"><p>{label(failed)}加载失败。{failed!=='design'?'已切换至设计参考。':'请稍后重新加载。'}</p><button type="button" className="button" onClick={()=>select(failed)}>重新加载{label(failed)}</button></div>}
  {mode==='design'?failed!=='design'&&<img key={`design-${attempt}`} className="design-board" src={imageFor(game)} alt={`${game.name}设计参考图`} onError={unavailable}/>:<div className="playable-preview">{mode==='screen'?<img key={`screen-${attempt}`} src={media.screen} alt={`${game.name}手机实玩画面`} onError={unavailable}/>:<video key={`motion-${attempt}`} controls playsInline preload="metadata" poster={media.screen} src={media.motion} aria-label={`${game.name}实际游戏录屏`} onError={unavailable}/>}<p>{mode==='screen'?'手机尺寸下的实际游戏画面':'实际操作录屏不含音轨，打开游戏可体验音乐与音效'}</p></div>}
 </div>;
}
