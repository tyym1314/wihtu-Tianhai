/** Plate layouts (design px on the 941x1672 plates) for roulette / SicBo table games. cells: id -> [x, y, w, h]. */
export const TABLES={
 roulette:{drawer:{type:'roulette',wheel:[470,480,280,160,158]},outcome:[470,480],
  cells:{zero:[38,990,212,152],d1:[250,990,220,152],d2:[470,990,219,152],d3:[689,990,216,152],red:[38,1146,212,152],black:[250,1146,220,152],even:[470,1146,219,152],odd:[689,1146,216,152]},
  timer:[467,924,52],balance:[189,1478,152,48],chips:{xs:[194,300,406,512,621],y:1586,r:48},repeat:[689,1515,232,109],
  results:[30,1339,879,73],resultsMax:14,banner:[170,820,600],backBtn:[88,97,45],rulesBtn:[852,97,45],menuY:160,
  glows:[[60,20,70],[880,20,70],[200,30,50],[740,30,50]],accent:'#ffd77a'},
 roulettepro:{drawer:{type:'roulette',wheel:[470,582,304,182,180]},outcome:[470,582],
  cells:{zero:[20,1118,233,159],d1:[253,1118,220,159],d2:[473,1118,221,159],d3:[694,1118,224,159],red:[20,1281,233,160],black:[253,1281,220,160],single:[473,1281,221,160],double:[694,1281,224,160]},
  timer:[247,1033,44],balance:[135,1522,150,52],chips:{xs:[330,414,497,580,664],y:1542,r:50},repeat:[712,1486,206,114],
  newBox:[37,1000,124,85],results:null,banner:[170,930,600],menuY:20,
  glows:[[120,300,90],[840,260,90],[470,140,120]],accent:'#c58cff'},
 sicbo:{drawer:{type:'dice',cup:[0,0,941,1672],lift:420,dice:[472,512,92]},outcome:[850,560],
  cells:{big:[36,675,274,360],triple:[335,675,272,360],small:[630,675,276,360]},
  timer:[820,382,50],balance:[72,1476,189,54],chips:{xs:[355,509,666,823],y:1368,r:66},repeat:[306,1472,594,139],
  newBox:[27,342,216,81],results:[130,1089,680,140],resultsStyle:'boxes',resultsMax:5,resultsDie:.26,banner:[170,1236,600],menuY:20,
  glows:[[150,190,70],[780,190,70],[60,130,60],[880,130,60]],accent:'#ffe9a0'},
};
