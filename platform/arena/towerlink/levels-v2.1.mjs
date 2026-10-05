/** Public deterministic geometry; competitive statistics never depend on art. */
export const LEVELS = Object.freeze([
  {id:'duel-twin-bridges',name:'双桥对峙',subtitle:'双线进攻 · 中央争夺',playerCount:2,variant:0},
  {id:'duel-ring-flank',name:'环形包抄',subtitle:'外围迂回 · 切断增援',playerCount:2,variant:1},
  {id:'trio-confluence',name:'三向争夺',subtitle:'三方等距 · 合围交锋',playerCount:3,variant:0},
  {id:'trio-outer-triangle',name:'三角外环',subtitle:'三路包抄 · 动态防守',playerCount:3,variant:1},
  {id:'quad-crossroads',name:'四方十字',subtitle:'四向对称 · 要塞争夺',playerCount:4,variant:0},
  {id:'quad-island-ring',name:'环岛混战',subtitle:'环路增援 · 侧翼争夺',playerCount:4,variant:1},
].map(Object.freeze));

// Every map has 12 ordinary towers and one central citadel. Each player's
// sector is an exact graph automorphism, including all road travel durations.
export function createBoard(playerCount, levelIndex=0) {
  const choices=LEVELS.filter(level=>level.playerCount===playerCount),level=choices[levelIndex];
  if(![2,3,4].includes(playerCount)||!Number.isInteger(levelIndex)||!level)throw new RangeError('Invalid Tower Link map');
  const outerCount=playerCount===3?9:8,innerCount=12-outerCount,coreId=12,towers=[],edges=[],roads=[],seen=new Set();
  const point=(i,count,r)=>({x:Number((.5+Math.sin(i/count*Math.PI*2)*r).toFixed(6)),y:Number((.5-Math.cos(i/count*Math.PI*2)*r).toFixed(6))});
  for(let i=0;i<outerCount;i++)towers.push({id:i,...point(i,outerCount,.43),ring:'outer',kind:'barracks',core:false,neighbors:[]});
  for(let i=0;i<innerCount;i++)towers.push({id:outerCount+i,...point(i,innerCount,levelIndex===0?.225:.255),ring:'inner',kind:'barracks',core:false,neighbors:[]});
  towers.push({id:coreId,x:.5,y:.5,ring:'core',kind:'citadel',core:true,neighbors:[]});
  function connect(a,b){
    if(a===b)return;const from=Math.min(a,b),to=Math.max(a,b),key=`${from}:${to}`;if(seen.has(key))return;seen.add(key);
    edges.push([from,to]);towers[from].neighbors.push(to);towers[to].neighbors.push(from);
    // Quantization protects symmetry from trigonometric roundoff and keeps
    // arrivals on the fixed simulation clock; identical roads have equal time.
    const length=Number(Math.hypot(towers[from].x-towers[to].x,towers[from].y-towers[to].y).toFixed(5));
    roads.push({id:key,from,to,travelMs:Math.max(2000,Math.min(5000,Math.ceil(length*10000/125)*125))});
  }
  for(let i=0;i<outerCount;i++)connect(i,(i+1)%outerCount);
  for(let i=0;i<outerCount;i++)connect(i,outerCount+(Math.floor(i*innerCount/outerCount+.5)%innerCount));
  for(let i=0;i<innerCount;i++){
    if(levelIndex===0)connect(outerCount+i,outerCount+(i+1)%innerCount);
    connect(outerCount+i,coreId);
  }
  towers.forEach(t=>t.neighbors.sort((a,b)=>a-b));edges.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);roads.sort((a,b)=>a.from-b.from||a.to-b.to);
  return{level:{...level},board:{kind:'radial',width:1,height:1,outerCount,innerCount},towers,edges,roads,starts:Array.from({length:playerCount},(_,i)=>i*outerCount/playerCount)};
}

/** Tutorial-only geometry. It is never selected for a competitive room. */
export function createTrainingBoard(lesson){
  if(lesson.number>=8){
    const map=createBoard(lesson.playerCount,lesson.number===11?1:0);
    if(![8,9,11].includes(lesson.number))return map;
    let pairs=map.edges;
    if(lesson.number===8)pairs=pairs.filter(([a,b])=>!(a>=8&&a<12&&b>=8&&b<12));
    if(lesson.number===9)pairs=[...pairs.filter(([a,b])=>!(a===0&&b===8)&&!(a===8&&[9,11,12].includes(b))),[1,8]];
    const towers=map.towers.map(t=>({...t,x:1-t.x,y:1-t.y,neighbors:[]}));
    return trainingMap(lesson,towers,pairs,map.starts,lesson.number===9?'broken-road':'river');
  }
  const seven=[4,7].includes(lesson.number);
  const points=seven?[[.5,.87],[.2,.68],[.8,.68],[.2,.3],[.8,.3],[.5,.12],[.5,.48]]:[[.5,.85],[.22,.53],[.78,.53],[.5,.15],[.5,.48]];
  let pairs=seven?[[0,1],[0,2],[0,6],[1,3],[2,4],[3,5],[4,5],[1,6],[2,6],[3,6],[4,6]]:[[0,1],[0,2],[0,4],[1,3],[2,3],[1,4],[2,4],[3,4]];
  if(lesson.number===6)pairs=[[0,1],[0,2],[1,4],[2,4],[3,4]];
  if(lesson.number===7)pairs=[[0,1],[0,2],[1,3],[2,4],[3,5],[4,5],[1,6],[2,6],[5,6]];
  const towers=points.map(([x,y],id)=>({id,x,y,ring:id===points.length-1?'inner':'outer',kind:'barracks',core:false,neighbors:[]}));
  return trainingMap(lesson,towers,pairs,[0,seven?5:3],lesson.number>=6?'river':null);
}
function trainingMap(lesson,towers,pairs,starts,terrain){
  const edges=pairs.map(([a,b])=>[Math.min(a,b),Math.max(a,b)]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const roads=edges.map(([from,to])=>{towers[from].neighbors.push(to);towers[to].neighbors.push(from);return{id:`${from}:${to}`,from,to,travelMs:Math.max(2000,Math.min(5000,Math.ceil(Math.hypot(towers[from].x-towers[to].x,towers[from].y-towers[to].y)*10000/125)*125))};});
  towers.forEach(t=>t.neighbors.sort((a,b)=>a-b));
  return{level:{id:`training-${lesson.id}`,name:lesson.title,subtitle:'免费教学 · 预置练习局面',playerCount:lesson.playerCount,variant:0},board:{kind:'training',width:1,height:1,terrain},towers,edges,roads,starts};
}
