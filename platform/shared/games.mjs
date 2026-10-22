import {CASINO_IDS} from './casino-games.mjs';
/** Local released game definitions. Client and server share admission and presentation metadata. */
export const ARENA_GAMES=Object.freeze({
 match:{id:'match',name:'三消对战',en:'MATCH ARENA',brand:['MATCH','ARENA'],tag:'EVERY MATCH IS MAGIC',players:[2,3,4],theme:'match',icon:'✦',duration:90000,scoreUnit:'分',description:'90 秒宝石对决。积分、指定宝石或特殊消除三种目标，同局同条件。',rules:['单指滑动或依次点击相邻宝石交换，3 个相同即可消除。','4 连生成条纹；5 连生成彩球；T/L 形生成炸弹。','每局固定积分、指定色收集或特殊触发目标；90 秒结束先比本局目标成绩，相同再比连锁积分。','目标门槛是挑战徽标，不提前结束比赛；同局所有玩家使用相同目标、初盘和补充序列。']},
 golf:{id:'golf',name:'迷你高尔夫',en:'MINI GOLF',brand:['MINI','GOLF'],tag:'A LITTLE PARADISE. A BIG RIVALRY.',players:[2,3,4],theme:'golf',icon:'⚑',duration:280000,scoreUnit:'杆',description:'九洞题库、三档难度，每局抽取三洞。瞄准绕障，用更少杆数赢得胜利。',rules:['九洞题库每局抽取三洞，入门、标准、挑战各一洞；同局玩家使用相同关卡。','在球道上点按瞄准，调整力度后击球。','落水或出界加罚 1 杆，回到本杆起点。','每杆 20 秒，每洞 90 秒；三洞总杆数越少越好。']},
 carrom:{id:'carrom',name:'Carrom 弹盘',en:'CARROM CLUB',brand:['CARROM','CLUB'],tag:'A PERFECT STRIKE. A PERFECT PARTNERSHIP.',players:[2,4],teamCapacity:4,theme:'carrom',icon:'◉',duration:600000,scoreUnit:'子',description:'翡翠木艺球桌，一击制胜。双人对决或四人搭档赛。',rules:['沿自己的基线放置打击器，调整方向与力度后击打。','先收过本方棋子才可收皇后；皇后需要用本方棋子覆盖。','20 秒一击，清完本方棋子且皇后已覆盖即获胜。','4 人为对座 2v2，任一队员弃权则全队弃权，胜队平分奖励。']},
 darts:{id:'darts',name:'飞镖对决',en:'DARTS DUEL',brand:['DARTS','DUEL'],tag:'FIND YOUR FOCUS. OWN THE NIGHT.',players:[2],theme:'darts',icon:'◎',duration:413000,scoreUnit:'剩余分',description:'霓虹靶场，301 直出。滑动投镖，用精确一击结束比赛。',rules:['拖动瞄准并投掷，每个回合最多 3 镖，共 20 秒。','剩余分减到 0 即完成；减成负数则整回合爆分并回退。','双方获得同轮机会后判胜，同轮归零并列。10 轮后比剩余分。']},
 ludo:{id:'ludo',name:'Ludo 快速版',en:'LUDO ROYALE',brand:['LUDO','ROYALE'],tag:'A ROYAL RACE TO HOME.',players:[2,4],theme:'ludo',icon:'⚄',duration:480000,scoreUnit:'进度',description:'双棋子皇家竞速。掷骰、吃子，抢先把两枚棋子送回家。',rules:['v1.1 新局每回合先点击揭示骰点，无合法走法在揭示后自动过轮；旧局继续固定原规则。','掷出 6 可出基地或前进 6 格，并获得额外机会。','第 3 个连续 6 作废本次机会；进家必须精确步数。','普通格可吃对手子，安全格共存。先送两子到终点者胜。']},
 jackaroo:{id:'jackaroo',name:'Jackaroo 搭档赛',en:'JACKAROO NIGHTS',brand:['JACKAROO','NIGHTS'],tag:'FOUR PLAYERS. TWO TEAMS. ONE CROWN.',players:[4],teamCapacity:4,theme:'jackaroo',icon:'♠',duration:720000,scoreUnit:'进度',description:'四人对座搭档赛。用扑克牌控制弹珠，默契决定胜负。',rules:['每手 4 张牌，先暗传 1 张给队友，再轮流出牌。','A/K 可出基地；4 后退；7 可完整拆分；J 可交换未保护对手珠。','自己 4 珠全部进家后帮助队友，先完成全队 8 珠者胜。','任一队员弃权即全队弃权。胜队两人均分奖励。完整牌效在游戏帮助中。']},
 domino:{id:'domino',name:'多米诺对战',en:'DOMINO LOUNGE',brand:['DOMINO','LOUNGE'],tag:'MAKE YOUR MOVE. READ THE ROOM.',players:[2,4],theme:'domino',icon:'▣',duration:300000,scoreUnit:'余点',description:'深蓝象牙牌桌。接龙、抽牌、封局，读懂每一步。',rules:['选择一张手牌，连接到点数相同的牌链左端或右端。','有合法牌必须出；无合法牌时抽到可出牌或牌堆抽空。','先出完手牌者胜；封局或到时比剩余点数，越少越好。']},
 pool:{id:'pool',name:'八球对决',en:'POOL MASTERS',brand:['POOL','MASTERS'],tag:'PRECISION IN EVERY SHOT.',players:[2],theme:'pool',icon:'❽',duration:600000,scoreUnit:'球',description:'孔雀青球台上的精确对决。瞄准、旋转、入袋，用一杆结束比赛。',rules:['开球不分组；之后首次合法进球确定实色或花色。','清空本组后先叫袋，无犯规地把黑八打入该袋获胜。','犯规给对方全台自由球。提前进黑八或黑八与白球同入袋判负。','每杆20秒，连续3次超时弃权；10分钟或100杆后按剩余本组球排名。']},
 bowling:{id:'bowling',name:'保龄球对决',en:'BOWLING STRIKE',brand:['BOWLING','STRIKE'],tag:'LIGHT UP THE LANE.',players:[2,3,4],theme:'bowling',icon:'♜',duration:180000,scoreUnit:'分',description:'霓虹3D球道。调准角度与旋转，打出完美全中。',rules:['调整站位、方向、力度与旋转；正中直球可能留分瓶，瞄准头瓶侧方口袋争取全中，偏角过大会落沟。','各自独立球道，完成3个计分局。每投准备20秒，出手后等待物理稳定记分，最长15秒。','全中加随后两投，补中加随后一投；最后一局按规则补投。','最高90分，总分相同并列，不按先投完者决胜。','180秒后未投机会记0分，已受理投球完成后计分。连续3次准备超时弃权。']},
 run:{id:'run',name:'沙丘竞速',en:'DUNE DASH',brand:['DUNE','DASH'],tag:'CHASE THE SUN. OWN THE FINISH.',players:[2,3,4],theme:'run',icon:'⚡',duration:100000,scoreUnit:'米',description:'六条沙丘路线、三档节奏。左右滑换道，上滑跳、下滑铲，和好友一起冲线。',rules:['三跑道自动前进，左右变道；跳过水沟，滑过低横梁。','每局固定一条路线，同局玩家使用相同赛道、道具与能力；重连仍是原路线。','480米终点，同一服务端模拟步冲线者并列；无人冲线则100秒后比净距离。','掉落返回最近检查点。断线30秒弃权，已冲线的有效成绩保留。']}
 ,towerlink:{id:'towerlink',name:'连线占塔',en:'TOWER LINK',brand:['TOWER','LINK'],tag:'DRAW THE LINE. CLAIM THE SKY.',players:[2,3,4],paidPlayers:[2],theme:'towerlink',icon:'⌁',duration:180000,scoreUnit:'座塔',description:'六张地图覆盖双环补给、外环包抄、中央桥头三类战术。拖线派兵、撤线调度，三分钟比拼攻防策略。',rules:['Lv.1 / 2 / 3 兵营总出兵 1 / 2 / 3 兵每秒，最多 1 / 2 / 3 路；要塞固定 2 兵每秒、最多 2 路。兵力在已开各路均分，整数余兵轮流分配，留守 5 兵；撤线不召回在途部队。','兵营自动产兵，手动消耗驻兵升级。施工暂停产兵与出兵，仍可接收援军和被攻打；自然产兵上限不截断援军。','同路相向军队与城门守军按公开规则交战，余兵占领敌塔。中立塔不产兵，中央要塞不额外计分。','180 秒结束先比占塔数，再比塔内及在途总活兵，仍相同则并列。没有塔但仍有在途部队不提前淘汰。','正式金币竞技仅双人，真正平局返还本金且不抽成。三人、四人只开放无奖池真人娱乐和明示 BOT 的免费练习。','个人断线 30 秒按弃权，己方塔转为中立、在途部队移除。全员弃权或无法恢复的整局故障返还入场币。']}
});
export const ARENA_IDS=Object.freeze(Object.keys(ARENA_GAMES));
export const LEGACY_IDS=Object.freeze(['thunder','tiger']);
export {CASINO_IDS};
/** Probability games: per-user cycles (thunder/tiger) and shared-round casino games. */
export const PROBABILITY_IDS=Object.freeze([...LEGACY_IDS,...CASINO_IDS]);
/**
 * Games withdrawn from the platform (server setting OASIS_RETIRED_GAMES, comma separated; production: thunder,tiger
 * since 2026-10-22). They leave the catalogue: no App can enable or launch them and startup removes them from every
 * App; their engines stay only to read and reconcile past rounds.
 */
export const RETIRED_IDS=Object.freeze((typeof process!=='undefined'&&process.env?.OASIS_RETIRED_GAMES||'').split(',').map(s=>s.trim()).filter(Boolean));
const live=ids=>ids.filter(id=>!RETIRED_IDS.includes(id));
export const RELEASED_IDS=Object.freeze(live([...LEGACY_IDS,...ARENA_IDS]));
/** Every game a partner or sandbox App can enable: the original catalogue plus casino games. */
export const ALL_GAME_IDS=Object.freeze(live([...RELEASED_IDS,...CASINO_IDS]));
export const teamSizeFor=(game,capacity)=>ARENA_GAMES[game]?.teamCapacity===capacity?2:1;
export const allowedCapacity=(game,capacity)=>Object.hasOwn(ARENA_GAMES,game)&&ARENA_GAMES[game].players.includes(capacity);
