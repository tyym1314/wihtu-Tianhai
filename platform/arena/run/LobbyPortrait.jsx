import React from 'react';
import {runLobbyPortraitPosition} from './lobby-portraits.mjs';
import './lobby-portraits.css';

export default function RunLobbyPortrait({kind,url}){
 return <span className="run-lobby-portrait" data-run-character={kind} aria-hidden="true"><i style={{backgroundImage:url?`url(${url})`:undefined,backgroundPosition:runLobbyPortraitPosition(kind)}}/></span>;
}
