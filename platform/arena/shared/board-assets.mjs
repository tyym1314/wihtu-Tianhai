import {preloadImages} from './image-preloader.mjs';
const portrait='/arena/assets/restoration/player-portraits-v2-mobile-e193e8ea76.webp';
const urls={
 carrom:[new URL('../carrom/assets/emerald-palace.webp',import.meta.url).href,new URL('../carrom/assets/v3/board-material.webp',import.meta.url).href,new URL('../carrom/assets/v3/disc-white.webp',import.meta.url).href,new URL('../carrom/assets/v3/disc-black.webp',import.meta.url).href,new URL('../carrom/assets/v3/disc-queen.webp',import.meta.url).href,new URL('../carrom/assets/v3/disc-striker.webp',import.meta.url).href],
 darts:[new URL('../darts/assets/v3/board-material.webp',import.meta.url).href,new URL('../darts/assets/v3/metal-dart.webp',import.meta.url).href,new URL('../darts/assets/v4/held-dart.webp',import.meta.url).href,new URL('../darts/assets/night-room-mobile-60782ace8b.webp',import.meta.url).href],
 pool:[new URL('../pool/club.svg',import.meta.url).href,new URL('../pool/assets/v3/board-material.webp',import.meta.url).href,new URL('../pool/assets/midnight-club-mobile-cb6f5ec471.webp',import.meta.url).href],
 ludo:[new URL('../ludo/assets/v3/board-material.webp',import.meta.url).href,new URL('../ludo/assets/players-atlas.webp',import.meta.url).href,...[new URL('../ludo/assets/v3/pawn-0.webp',import.meta.url).href,new URL('../ludo/assets/v3/pawn-1.webp',import.meta.url).href,new URL('../ludo/assets/v3/pawn-2.webp',import.meta.url).href,new URL('../ludo/assets/v3/pawn-3.webp',import.meta.url).href]],
 jackaroo:[new URL('../jackaroo/assets/v3/board-material.webp',import.meta.url).href,new URL('../jackaroo/assets/majlis.webp',import.meta.url).href,new URL('../jackaroo/assets/v3/marble-emerald.webp',import.meta.url).href,new URL('../jackaroo/assets/v3/marble-ivory.webp',import.meta.url).href,new URL('../ludo/assets/players-atlas.webp',import.meta.url).href],
 domino:[new URL('../domino/assets/v3/board-material.webp',import.meta.url).href,new URL('../domino/assets/v3/ivory-tile.webp',import.meta.url).href,new URL('../domino/assets/v3/palace.webp',import.meta.url).href,new URL('../ludo/assets/players-atlas.webp',import.meta.url).href],
};
export const boardAssetUrls=game=>[portrait,...(urls[game]||[])];
export const preloadBoardAssets=game=>preloadImages(boardAssetUrls(game));
