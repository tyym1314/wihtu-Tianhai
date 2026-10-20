/**
 * Compact half-screen layouts (voice-room game panel) built from the existing plates: per game, the
 * design-pixel bands [y0, y1) left out. The rest of the plate is stacked with a short cross-fade and every
 * overlay moves up by the height removed above it. Full screen is unchanged.
 * Only bands without live data or controls may be removed (titles, scenery, decoration).
 */
export const HALF_BANDS={
 olympus:[[40, 595]],
 teenpatti:[[288, 640]],
 greedylion:[[282, 545]],
 oceanslot:[[40, 690]],
 mahjongslot:[[40, 398]],
 cleopatraslot:[[40, 410]],
 crazygems:[[40, 525]],
 slot777:[[40, 580]],
 djlive:[[40, 503]],
 jackpotslots:[[40, 385]],
 yummy:[[40, 532]],
 worldgoal:[[40, 405]],
 chillislot:[[40, 556]],
 sphinxlegend:[[40, 652]],
 nights1001:[[40, 549]],
 pyramidslots:[[40, 551]],
 magicslot:[[40, 477]],
 crash:[[110, 385]],
 glorycup:[[40, 593]],
 crazyfruit:[[40, 331]],
 fruitparty:[[40, 317]],
 bountyfootball:[[40, 305]],
 footballleague:[[40, 320]],
 molestar:[[175, 320]],
 crashstar:[[130, 295]],
};

/** Decoration that disappears with its band; any other overlay inside a removed band is pinned to the seam. */
export const DECORATIVE=/(^|\s)(cs-glow|cs-sparkle|ol-eye)(\s|$)/;

/** Above this width/height the view is a half-screen panel rather than a phone screen. */
export const HALF_MIN_ASPECT=0.6;

export function halfLayout(id,height=1672){
 const cut=HALF_BANDS[id];if(!cut?.length)return null;
 const kept=[];let y=0;for(const [a,b] of cut){if(a>y)kept.push([y,a]);y=b;}if(y<height)kept.push([y,height]);
 const removedAbove=v=>cut.reduce((s,[a,b])=>s+(v>=b?b-a:v>a?v-a:0),0);
 const cutAt=v=>cut.find(([a,b])=>v>a&&v<b);
 return {kept,height:height-cut.reduce((s,[a,b])=>s+b-a,0),removedAbove,cutAt};
}
