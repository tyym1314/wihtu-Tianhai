const capturedPreview = id => ({screen:`/previews/${id}.png`,motion:`/previews/${id}.webm`});
export const games = [
  { sample:true, id:'carrom', preview:capturedPreview('carrom'), name:'Carrom 弹盘', en:'CARROM CLUB', category:'competitive', players:'2 / 4 人', mode:'1v1 · 2v2', render:'2.5D 物理', theme:'翡翠木艺', art:'01-carrom.webp', accent:'#49876d' },
  { id:'match', preview:capturedPreview('match'), name:'三消对战', en:'MATCH ARENA', category:'competitive', players:'2–4 人', mode:'90 秒竞分', render:'2.5D 宝石与分层动画', sample:true, theme:'紫晶奇境', art:'02-match.webp', accent:'#8d70b6' },
  { id:'golf', preview:capturedPreview('golf'), name:'绿洲高尔夫', en:'OASIS GOLF', category:'competitive', players:'2–4 人', mode:'三洞短赛', render:'真 3D', sample:true, theme:'浮岛绿洲', art:'03-golf.webp', accent:'#28a69c' },
  { sample:true, id:'darts', preview:capturedPreview('darts'), name:'飞镖对决', en:'DARTS DUEL', category:'competitive', players:'2 人', mode:'301 直出', render:'2.5D', theme:'霓虹竞技场', art:'04-darts.webp', accent:'#4384af' },
  { sample:true, id:'ludo', preview:capturedPreview('ludo'), name:'Ludo 快速版', en:'LUDO ROYALE', category:'competitive', players:'2 / 4 人', mode:'双棋子快局', render:'2.5D 棋盘', theme:'皇家棋局', art:'05-ludo.webp', accent:'#bf924c' },
  { sample:true, id:'pool', preview:capturedPreview('pool'), name:'八球对决', en:'POOL MASTERS', category:'competitive', players:'2 人', mode:'经典八球', render:'2.5D 物理', theme:'孔雀蓝球台', art:'06-pool.webp', accent:'#237b88' },
  { sample:true, id:'bowling', preview:capturedPreview('bowling'), name:'保龄球对决', en:'BOWLING STRIKE', category:'competitive', players:'2–4 人', mode:'三局短赛', render:'真 3D', theme:'霓虹球道', art:'07-bowling.webp', accent:'#89569d' },
  { sample:true, id:'jackaroo', preview:capturedPreview('jackaroo'), name:'Jackaroo 搭档赛', en:'JACKAROO NIGHTS', category:'competitive', players:'4 人', mode:'2v2 队伍赛', render:'2.5D 棋盘', theme:'胡桃木与翡翠', art:'08-jackaroo.webp', accent:'#537b58' },
  { sample:true, id:'domino', preview:capturedPreview('domino'), name:'多米诺对战', en:'DOMINO LOUNGE', category:'competitive', players:'2 / 4 人', mode:'双六单盘', render:'2.5D 牌桌', theme:'深蓝象牙', art:'09-domino.webp', accent:'#456c96' },
  { sample:true, id:'run', preview:capturedPreview('run'), name:'沙丘竞速', en:'DUNE DASH', category:'competitive', players:'2–4 人', mode:'多人道具竞速', render:'真 3D', theme:'动物绿洲', art:'10-run.webp', accent:'#b58c49' },
  { sample:true, id:'towerlink', name:'连线占塔', en:'TOWER LINK', category:'competitive', players:'2–4 人', mode:'持续兵线 · 手动升级 · 领土争夺', render:'2.5D 战场', theme:'云端王国', art:'11-towerlink.svg', accent:'#4d9ab1' },
  { id:'thunder', name:'雷霆王座', en:'THUNDER THRONE', category:'probability', players:'1 人', mode:'连消 · 免费回合', render:'2.5D', theme:'众神之巅', art:'thunder-main.webp', accent:'#796fa6', demo:'http://127.0.0.1:8787/' },
  { id:'tiger', name:'虎虎生财', en:'FORTUNE TIGER', category:'probability', players:'1 人', mode:'重转 · 满盘奖励', render:'2.5D', theme:'金玉招财', art:'tiger-scene.webp', accent:'#c38932', demo:'http://127.0.0.1:8790/' }
];
// Casino games (released only), generated from the shared definitions.
import {CASINO_GAMES,CASINO_IDS} from '../shared/casino-games.mjs';
const FAMILY={wheel:'共享回合押注',crash:'爆点 · 实时提现',cards3:'三家比牌',slot:'老虎机'};
for(const id of CASINO_IDS){const g=CASINO_GAMES[id];games.push({id,name:g.name,en:g.name.toUpperCase(),category:'casino',players:g.kind==='instant'?'1 人':'多人同局',mode:FAMILY[g.family]||g.family,render:'2.5D',theme:g.reference,art:null,artUrl:`/casino/${id}/plate.webp`,accent:'#c38932'});}
export const imageFor = game => game.artUrl||`/assets/${game.art}`;
