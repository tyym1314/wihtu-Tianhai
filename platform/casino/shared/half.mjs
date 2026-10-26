/**
 * Compact half-screen layouts (voice-room game panel, width/height 0.8) built from the existing plates.
 * Per game, design-pixel bands: [y0, y1] is left out, [y0, y1, s] is squeezed vertically to s (0 < s < 1).
 * The rest of the plate is stacked with a short cross-fade and every overlay follows its band. A side gap that
 * is still left is filled with a mirror of the plate's edge. Full screen is unchanged.
 * Only bands without live data or controls may be removed (titles, scenery, decoration).
 */
export const HALF_BANDS={
 olympus:[[99, 595]],
 teenpatti:[[288, 640]],
 greedylion:[[282, 545]],
 oceanslot:[[194, 690]],
 mahjongslot:[[40, 398]],
 cleopatraslot:[[40, 410]],
 crazygems:[[40, 525]],
 slot777:[[84, 580]],
 djlive:[[40, 503]],
 jackpotslots:[[40, 385]],
 yummy:[[40, 532]],
 worldgoal:[[40, 405]],
 chillislot:[[60, 556]],
 sphinxlegend:[[156, 652]],
 nights1001:[[53, 549]],
 pyramidslots:[[55, 551]],
 magicslot:[[40, 477]],
 crash:[[110, 385]],
 glorycup:[[97, 593]],
 crazyfruit:[[40, 331]],
 fruitparty:[[80, 317]],
 bountyfootball:[[40, 305]],
 footballleague:[[40, 320]],
 molestar:[[175, 320]],
 crashstar:[[130, 295]],
};

/**
 * Games without removable bands: in the panel the plate keeps its proportions (scaled to the panel height) and a
 * wide plate (plate-wide.webp, scenery extended left and right by image generation) fills the sides.
 */
export const HALF_WIDE=new Set(['rocketstar2','greedycat2','greedybrutal','bigeater','greedyking','greedyforest','herochest','magiccard','solomonmines','roulette','roulettepro','sicbo','monster','fruitmachine','piratefish']);
export const WIDE_WIDTH=1338;

/** Panel ratio the voice room uses for every game (WithU sends aspectRatio=0.8). */
export const HALF_TARGET=0.8;
/** Above this width/height the view is a half-screen panel rather than a phone screen. */
export const HALF_MIN_ASPECT=0.6;

/** Decoration that disappears with its band; any other overlay inside a removed band is pinned to the seam. */
export const DECORATIVE=/(^|\s)(cs-glow|cs-sparkle|ol-eye)(\s|$)/;

/** Segments covering the plate: {a, b, s} with s = 1 (kept), 0 (removed) or the squeeze factor. */
export function halfLayout(id,height=1672){
 const bands=HALF_BANDS[id];if(!bands?.length)return null;
 const seg=[];let y=0;
 for(const [a,b,s=0] of bands){if(a>y)seg.push({a:y,b:a,s:1});seg.push({a,b,s});y=b;}
 if(y<height)seg.push({a:y,b:height,s:1});
 const map=v=>{let out=0;for(const g of seg){if(v>=g.b){out+=(g.b-g.a)*g.s;continue;}if(v>g.a)out+=(v-g.a)*g.s;break;}return out;};
 const cutAt=v=>{const g=seg.find(g=>g.s===0&&v>g.a&&v<g.b);return g?[g.a,g.b]:null;};
 return {segments:seg,height:Math.round(map(height)),map,cutAt,removedAbove:v=>v-map(v)};
}

// The half layout currently on screen (set by Stage), so effects aimed in full-plate pixels land correctly.
export let activeHalf=null;
export const setActiveHalf=h=>{activeHalf=h;};
