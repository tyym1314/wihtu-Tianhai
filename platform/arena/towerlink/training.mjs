/** Browser-safe lesson metadata and pure training helpers; no Node imports. */
export const TRAINING_VERSION='tower-training-20260928-v2';
export const TRAINING_LESSONS=Object.freeze([
  ['认识产兵','观察自动产生至少 3 兵，并占领标记的中立塔。','5 塔基础教学；双方兵营产速相同，AI 前 60 秒驻守。',2,8000,60000],
  ['持续派兵与驻守','向目标持续派出至少 8 兵，停止出兵后再自动产生 2 兵。','5 塔操作教学；停止指令不会召回已经出发的部队。',2,8000,60000],
  ['增援与前线中继','后方增援前线至少 8 兵，再由前线继续派兵并占领目标塔。','预置两座己方兵营；前线只有 5 守兵，增援必须真实抵达。',2,6000,45000],
  ['道路交战与集火','在标记道路发生至少 8 兵损耗的交战，并夺取敌方前哨。','7 塔预置战局；你有两座兵营，敌方前哨已向你的左翼派兵。',2,5000,15000],
  ['手动升级','完成一座兵营的 Lv.2 升级，随后由它实际产生至少 4 兵。','升级消耗本塔 20 兵，施工 3 秒；AI 前 60 秒驻守。',2,8000,60000],
  ['岔路回防','先向右翼派出 4 兵，再断开旧线，向受攻击的左翼送达至少 4 兵。','峡谷只有左右两条通路。敌方 Lv.2 前哨正在压迫左翼，AI 2 秒后开始每 1.8 秒决策。',2,1800,2000],
  ['双翼补给','升级后方，向两翼各送达 6 兵；两翼分别攻入前哨，并保住后方夺取前哨。','中央没有直达捷径。敌后方正向前哨补给，AI 2 秒后每 1.5 秒决策；两翼需要持续增援。',2,1500,2000],
  ['桥头堡争夺','夺取中央要塞，控制期间送达 8 名援军，并连续守住 12 秒。','内圈横向通路已被河道隔开。敌军从对岸前哨推进，AI 2 秒后每 1.6 秒决策；可抢桥头或绕外圈。',2,1600,2000],
  ['侧翼反攻','占领侧翼中继站，再夺回出生塔；保住预备兵营并连续控制出生塔 10 秒。','通往出生塔的直路已断，须经两侧绕行。敌方从出生塔进攻中继站，AI 1 秒后每 1.4 秒决策。',2,1400,1000],
  ['三方合围抵消','观察中央 5／4／2 兵同刻交战，再亲自占领标记的中立塔。','三方各有预置小队同时前往零驻兵要塞；5／4／2 将全部抵消，随后正常对战。',3,4000,15000],
  ['限时建立防线','亲自夺取 3 座不同的塔；45 秒结束时保住两处补给基地，并控制至少 5 塔。','45 秒守备任务：己方 2 塔、敌方 3 塔。AI 1 秒后每 1.4 秒扩张；在投资、抢点和保护补给基地之间取舍。',2,1400,1000],
  ['完整对局考核','按照正式的 180 秒规则，击败公开标记的 AI 对手。','完整 13 塔标准开局；AI 每 1.2 秒决策，双方产兵、升级与交战规则完全相同。',2,1200,0],
].map(([title,objective,setupDescription,playerCount,botIntervalMs,botStartsAfterMs],i)=>Object.freeze({id:`lesson-${String(i+1).padStart(2,'0')}`,number:i+1,title,objective,setupDescription,playerCount,botIntervalMs,botStartsAfterMs,durationMs:i===10?45000:180000})));
export const getTrainingLesson=id=>TRAINING_LESSONS.find(lesson=>lesson.id===id)??null;
const steps={
  1:[['produced','自动产兵',3],['capture','占领目标塔',1]],
  2:[['sent','持续派兵',8],['stopped','停止出兵',1],['regrown','停止后产兵',2]],
  3:[['reinforced','后方向前线增援',8],['relayed','前线继续派兵',8],['capture','占领目标塔',1]],
  4:[['roadCasualties','道路交战损耗',8],['capture','夺取前哨',1]],
  5:[['upgraded','完成 Lv.2 升级',1],['advancedProduced','升级后实际产兵',4]],
  6:[['outbound','先向右侧派兵',4],['changed','移除右路并连接左路',1],['defended','回防增援抵达',4]],
  7:[['suppliedLeft','后方向左翼补给',6],['suppliedRight','后方向右翼补给',6],['leftAttack','左翼真实抵达',4],['rightAttack','右翼真实抵达',4],['upgraded','后方升级完成',1],['capture','夺取前哨',1]],
  8:[['capture','夺取要塞',1],['reinforcedCore','控制期间送达援军',8],['heldSeconds','连续控制要塞',12]],
  9:[['bridgeCaptured','占领侧翼中继站',1],['recaptured','夺回出生塔',1],['homeHeldSeconds','控制出生塔',10]],
  10:[['coalition','观察三方抵消',1],['capture','亲自占领目标塔',1]],
  11:[['distinctCaptures','亲自夺取不同塔',3],['timeUp','到时判定',1],['heldBases','到时保住补给基地',2],['heldTowers','到时控制塔数',5]],
  12:[['won','正式规则获胜',1]],
};
export function makeTraining(lesson,learnerKey,targets,markers){
  return{lessonId:lesson.id,trainingVersion:TRAINING_VERSION,scenarioVersion:2,botProfile:{intervalMs:lesson.botIntervalMs,startsAfterMs:lesson.botStartsAfterMs},learnerKey,title:lesson.title,objective:lesson.objective,setupDescription:lesson.setupDescription,targets,markers,progress:steps[lesson.number].map(([id,label,target])=>({id,label,current:0,target,done:false})),completed:false,failed:false,completedAt:null,failedReason:null,nextLessonId:TRAINING_LESSONS[lesson.number]?.id??null,metrics:{},routes:{},botLastActionAt:{},centerOwnedSince:null,homeOwnedSince:null,capturedTowers:[]};
}
export function observeTraining(state,event){
  const training=state.training;if(!training||training.completed||training.failed)return;
  const m=training.metrics,t=training.targets,key=training.learnerKey,lesson=getTrainingLesson(training.lessonId),mine=event.ownerKey===key||event.playerKey===key;
  const add=(name,value=1)=>{m[name]=(m[name]||0)+value;};
  if(event.type==='production'&&mine){
    add('produced',event.count);
    if(event.level>=2&&m.upgraded)add('advancedProduced',event.count);
    if(m.stopped&&event.towerId===t.home&&state.orders[t.home]===null)add('regrown',event.count);
  }
  if(event.type==='dispatch'&&mine){
    if(event.from===t.home){add('sent',event.count);if(event.to===t.attack)add('outbound',event.count);}
    if(event.from===t.front&&m.reinforced>=8)add('relayed',event.count);
  }
  if(['link','unlink','stop'].includes(event.type)&&mine){
    const from=event.type==='stop'?event.towerId:event.from,previous=training.routes[from]??[];
    if(event.type==='link')training.routes[from]=[...new Set([...previous,event.to])];
    else if(event.type==='unlink')training.routes[from]=previous.filter(to=>to!==event.to);
    else training.routes[from]=[];
    if(from===t.home&&m.outbound>=4){
      if(previous.includes(t.attack)&&!training.routes[from].includes(t.attack))m.attackRemoved=1;
      if(m.attackRemoved&&!training.routes[from].includes(t.attack)&&training.routes[from].includes(t.defend))m.changed=1;
    }
  }
  if(mine&&m.sent>=8&&((event.type==='stop'&&event.towerId===t.home)||(event.type==='unlink'&&event.from===t.home&&state.orders[t.home]===null))){m.stopped=1;m.regrown=0;}
  if(event.type==='upgrade-complete'&&mine&&(lesson.number!==7||event.towerId===t.home))add('upgraded');
  if(event.type==='road-battle'&&event.participants?.some(p=>p.ownerKey===key)&&event.edge.includes(t.front??t.home))add('roadCasualties',event.casualties);
  if(event.type==='arrival'){
    const own=event.arrived.filter(a=>a.ownerKey===key);
    if(event.previousOwner===key&&event.ownerKey===key){
      if(event.towerId===t.front)add('reinforced',own.filter(a=>a.from===t.home).reduce((n,a)=>n+a.count,0));
      if(event.towerId===t.defend&&m.changed)add('defended',own.filter(a=>a.from===t.home).reduce((n,a)=>n+a.count,0));
      if(lesson.number===7&&event.towerId===t.left)add('suppliedLeft',own.filter(a=>a.from===t.home).reduce((n,a)=>n+a.count,0));
      if(lesson.number===7&&event.towerId===t.right)add('suppliedRight',own.filter(a=>a.from===t.home).reduce((n,a)=>n+a.count,0));
      if(lesson.number===8&&event.towerId===t.target)add('reinforcedCore',own.reduce((n,a)=>n+a.count,0));
    }
    if(event.towerId===t.target){
      add('leftAttack',own.filter(a=>a.from===t.left).reduce((n,a)=>n+a.count,0));
      add('rightAttack',own.filter(a=>a.from===t.right).reduce((n,a)=>n+a.count,0));
    }
    if(event.towerId===t.coalition&&event.participants?.filter(p=>p.count>0&&p.ownerKey!==null).length>=3&&event.casualties>=11)add('coalition');
  }
  if(event.type==='capture'){
    if(mine){training.capturedTowers??=[];if(!training.capturedTowers.includes(event.towerId))training.capturedTowers.push(event.towerId);m.distinctCaptures=training.capturedTowers.length;}
    if(event.towerId===t.target){
      if(mine){m.capture=1;if(lesson.number===8)training.centerOwnedSince=event.at;}
      else{m.capture=0;training.centerOwnedSince=null;if(lesson.number===8)m.reinforcedCore=0;}
    }
    if(lesson.number===9){if(event.towerId===t.bridge&&mine)m.bridgeCaptured=1;if(event.towerId===t.home){m.recaptured=mine?1:0;training.homeOwnedSince=mine?event.at:null;}}
  }
  if(event.type==='finish'){
    if(event.reason==='deadline'){m.timeUp=1;if(lesson.number===11){m.heldBases=[t.home,t.reserve].filter(id=>state.owners[id]===key).length;m.heldTowers=state.owners.filter(owner=>owner===key).length;}}
    if(['deadline','conquest'].includes(event.reason)&&event.winnerKeys.length===1&&event.winnerKeys[0]===key)m.won=1;
  }
}
export function updateTraining(state,at){
  const training=state.training;if(!training||training.completed||training.failed)return;
  const lesson=getTrainingLesson(training.lessonId),m=training.metrics,key=training.learnerKey;
  if(lesson.number===8)m.heldSeconds=training.centerOwnedSince===null?0:Math.max(0,Math.floor((at-training.centerOwnedSince)/1000));
  if(lesson.number===9)m.homeHeldSeconds=training.homeOwnedSince==null?0:Math.max(0,Math.floor((at-training.homeOwnedSince)/1000));
  training.progress=training.progress.map(p=>({...p,current:Math.min(p.target,m[p.id]||0),done:(m[p.id]||0)>=p.target}));
  const all=training.progress.every(p=>p.done),ownsRequiredHome=(lesson.number!==7||state.owners[training.targets.home]===key)&&(lesson.number!==9||training.targets.reserve==null||state.owners[training.targets.reserve]===key);
  if(all&&ownsRequiredHome&&!state.players[key].forfeited){training.completed=true;training.completedAt=at;return;}
  if(state.status==='finished'||state.players[key].forfeited||state.players[key].eliminated){training.failed=true;training.failedReason=state.players[key].forfeited?'已退出训练':state.players[key].eliminated?'所有兵营和部队已失去':'本局结束，教学目标尚未完成';}
}
// Existing serialized training rooms retain the reaction cadence they started
// with. New rooms freeze their profile instead of looking up mutable metadata.
export function trainingBotProfile(training){
 if(training.botProfile)return training.botProfile;
 const old={6:[6000,45000],7:[4000,15000],8:[4000,15000],9:[3600,12000],11:[8000,60000]},lesson=getTrainingLesson(training.lessonId),values=old[lesson.number];
 return values?{intervalMs:values[0],startsAfterMs:values[1]}:{intervalMs:lesson.botIntervalMs,startsAfterMs:lesson.botStartsAfterMs};
}
export function publicTraining(state){
  const t=state.training;if(!t)return null;
  const {lessonId,learnerKey,title,objective,setupDescription,markers,progress,completed,failed,nextLessonId,completedAt,failedReason}=t;
  return{lessonId,learnerKey,title,objective,setupDescription,markers,progress,completed,failed,nextLessonId,completedAt,failedReason};
}
