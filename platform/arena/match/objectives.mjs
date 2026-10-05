export const MATCH_CONTENT_VERSION='match-objectives-v2.0.0';
export const MATCH_OBJECTIVES=Object.freeze([
 Object.freeze({id:'score',target:1000,title:{zh:'连锁积分赛',en:'Cascade Score',ar:'نقاط السلسلة'}}),
 Object.freeze({id:'collect',target:24,title:{zh:'宝石收集赛',en:'Gem Collection',ar:'جمع الجواهر'}}),
 Object.freeze({id:'special',target:4,title:{zh:'特殊消除赛',en:'Special Effects',ar:'تفعيل الجواهر الخاصة'}}),
]);
export function selectMatchObjective(seed){const value=Number.parseInt(seed.slice(0,8),16);return{...MATCH_OBJECTIVES[value%3],color:value%3===1?Number.parseInt(seed.slice(8,10),16)%5:null};}
export function objectiveValue(player,objective){return objective.id==='score'?player.score:player.objectiveProgress||0;}
export function objectiveWaveProgress(wave,objective){
 if(objective.id==='collect')return wave.removed.filter(index=>wave.before[index]?.color===objective.color).length;
 if(objective.id==='special')return wave.effects.length;
 return 0;
}
export function objectiveCopy(objective,locale='en',colors=[]){
 const zh=locale==='zh',ar=locale==='ar',title=objective.title[locale]||objective.title.en;
 const name=colors[objective.color]||String((objective.color??0)+1);
 const instruction=objective.id==='score'?(zh?'连锁得分越高，排名越高':ar?'ترتيب حسب أعلى النقاط':'Highest cascade score wins'):objective.id==='collect'?(zh?`优先消除${name}；收集数相同再比积分`:ar?`اجمع ${name}؛ النقاط تفصل التعادل`:`Collect ${name}; score breaks collection ties`):(zh?'触发条纹、炸弹和彩球；触发数相同再比积分':ar?'فعّل الجواهر الخاصة؛ النقاط تفصل التعادل':'Trigger stripes, bombs and rainbows; score breaks ties');
 return{title,instruction,unit:objective.id==='score'?(zh?'分':ar?'نقطة':'pts'):objective.id==='collect'?(zh?'颗':ar?'جوهرة':'gems'):(zh?'次':ar?'تفعيل':'effects'),targetLabel:zh?'挑战目标':ar?'هدف التحدي':'Challenge target'};
}
