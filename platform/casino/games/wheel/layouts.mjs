/**
 * Plate layouts for wheel-family games, in design pixels on each 941x1672 concept plate.
 * items: id -> [cx, cy, r] (round plates) or [cx, cy, w, h] (cards/tiles); order = light-chase order.
 * Shared by the front-end and scripts/casino-icons.mjs (icons cropped from the plate).
 */
export const LAYOUTS={
 greedycat2:{bannerY:1200,order:['tomato','corn','carrot','broccoli','fish','crab','steak','chicken'],
  items:{tomato:[472,498,84],corn:[690,589,84],carrot:[774,799,84],broccoli:[690,1012,84],fish:[472,1104,84],crab:[248,1012,84],steak:[164,799,84],chicken:[248,589,84]},
  timer:[474,159,75],balance:[720,60,142,42],winners:[678,171,243,260,5],center:[472,816,150],
  chips:{xs:[100,238,375,512,646],y:1391,r:60},repeat:[732,1351,181,84],results:[33,1525,875,97],
  glows:[[40,401,90],[352,301,70],[574,109,60],[871,527,90],[209,251,60]],accent:'#ffb347'},
 greedyking:{bannerY:1050,order:['hotdog','carrot','kebab','ham','cabbage','steak','corn','tomato'],
  items:{hotdog:[472,405,80],carrot:[686,493,80],kebab:[767,699,80],ham:[686,908,80],cabbage:[472,990,80],steak:[251,908,80],corn:[176,699,80],tomato:[251,493,80]},
  groups:{salad:[30,1167,430,179],pizza:[481,1167,432,179]},
  timer:[469,137,84],balance:[703,40,159,40],winners:[683,147,241,201,3],center:[469,711,150],
  chips:{xs:[95,221,348,476,603],y:1430,r:55},repeat:[690,1374,223,114],results:[270,1530,634,100],
  glows:[[60,300,90],[880,300,90],[120,1080,80],[820,1080,80]],accent:'#ffd34d'},
 greedybrutal:{bannerY:1170,order:['tiger','goat','horse','wolf','leopard','deer','eagle','bull'],
  items:{tiger:[469,460,100],goat:[695,543,100],horse:[795,777,100],wolf:[703,1023,100],leopard:[469,1107,100],deer:[234,1023,100],eagle:[142,777,100],bull:[243,543,100]},
  timer:[469,109,75],balance:[678,28,193,42],winners:[645,147,268,221,3],center:[469,777,170],
  chips:{xs:[159,315,469,625,780],y:1307,r:70},repeat:[276,1396,385,97],results:[33,1558,875,97],
  glows:[[37,1187,90],[904,1187,90]],accent:'#ff8a3c'},
 bigeater:{bannerY:650,order:['sausage','drumstick','shrimp','steak','corn','mushroom','turnip','tomato'],
  items:{sausage:[127,963,214,231],drumstick:[357,963,214,231],shrimp:[586,963,214,231],steak:[814,963,214,231],tomato:[124,1217,214,231],turnip:[355,1217,214,231],mushroom:[586,1217,214,231],corn:[817,1217,214,231]},
  timer:[481,117,84],balance:[712,66,142,42],winners:[20,309,285,243,3],center:[500,620,140],
  chips:{xs:[84,211,340,469,598],y:1441,r:55},repeat:[678,1391,240,102],results:[37,1572,876,75],
  glows:[[610,40,60],[700,180,60],[800,250,60],[160,560,70]],accent:'#ffb347'},
 fruitparty:{bannerY:1240,order:['cherry','lemon','orange','bell','star','seven','watermelon','plum'],
  items:{cherry:[199,716,204,204],lemon:[414,716,204,204],orange:[630,716,204,204],plum:[199,928,204,204],bell:[630,928,204,204],watermelon:[199,1150,204,204],seven:[414,1150,204,204],star:[630,1150,204,204]},
  jackpot:[502,337,318,38],miniReels:[[223,431,145,129],[382,431,171,129],[566,431,151,129]],
  timer:[414,928,75],balance:[728,56,143,42],winners:[782,722,147,432,5],center:null,
  chips:{xs:[97,251,404,561],y:1410,r:67},repeat:[653,1329,273,164],results:[176,1541,728,89],
  glows:[[150,140,80],[900,470,70],[30,1200,80],[910,1210,80]],accent:'#ffe066'},
};
