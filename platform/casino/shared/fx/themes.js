/** Particle colours per game (coins stay gold; sparks and confetti follow the game's art). */
const GOLD=['#ffe58a','#f5b52e','#a86a0e'];
const T=(spark,confetti,coin=GOLD)=>({coin,spark,confetti});
const THEMES={
 fruitmachine:T(['#fff6c8','#ff8a2e','#ffd34d'],['#ff3b5c','#ffd34d','#7dff8a','#ff8a2e','#56d1ff']),
 piratefish:T(['#e6fbff','#57e2ff','#ffd34d'],['#57e2ff','#ffd34d','#ff5c7a','#ffffff']),
 olympus:T(['#fffbe6','#9fd8ff','#ffd34d'],['#ffd34d','#9fd8ff','#ffffff','#c58bff']),
 oceanslot:T(['#e6fbff','#56d1ff','#7dffe0'],['#56d1ff','#7dffe0','#ffd34d','#ffffff']),
 mahjongslot:T(['#fff2c2','#ff5c5c','#ffd34d'],['#ff3b3b','#ffd34d','#3bd16f','#ffffff']),
 cleopatraslot:T(['#fff2c2','#ffd34d','#56d1ff'],['#ffd34d','#1fb5c9','#c98a12','#ffffff']),
 crazygems:T(['#ffffff','#ff5cf0','#56d1ff'],['#ff5cf0','#56d1ff','#7dff8a','#ffd34d','#ff5c5c']),
 slot777:T(['#fff6c8','#ff3b3b','#ffd34d'],['#ff3b3b','#ffd34d','#ffffff','#56d1ff']),
 djlive:T(['#ffffff','#ff5cf0','#56ffe8'],['#ff5cf0','#56ffe8','#c58bff','#ffd34d']),
 jackpotslots:T(['#fff6c8','#ffd34d','#ff5c7a'],['#ffd34d','#ff5c7a','#56d1ff','#7dff8a']),
 yummy:T(['#fff0f6','#ff8ac8','#ffd34d'],['#ff8ac8','#ffd34d','#8affd8','#c58bff']),
 worldgoal:T(['#ffffff','#7dff8a','#ffd34d'],['#3bd16f','#ffffff','#ffd34d','#56d1ff']),
 chillislot:T(['#fff2c2','#ff5c2e','#ffd34d'],['#ff3b2e','#ffd34d','#3bd16f','#ff8a2e']),
 sphinxlegend:T(['#fff2c2','#ffd34d','#56d1ff'],['#ffd34d','#1fb5c9','#c98a12','#ffffff']),
 nights1001:T(['#fff2c2','#c58bff','#ffd34d'],['#c58bff','#ffd34d','#56d1ff','#ff5c7a']),
 pyramidslots:T(['#fff2c2','#ffd34d','#ff9f2e'],['#ffd34d','#ff9f2e','#1fb5c9','#ffffff']),
 magicslot:T(['#ffffff','#c58bff','#56d1ff'],['#c58bff','#56d1ff','#ff5cf0','#ffd34d']),
};
export const themeOf=id=>THEMES[id]||T(['#fff6c8','#ffd34d','#ff9f2e'],['#ffd34d','#ff5c7a','#56d1ff','#7dff8a','#c58bff']);
