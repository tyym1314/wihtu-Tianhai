import {preloadImages} from '../shared/image-preloader.mjs';
// Keep same-origin CSS/Image cache mode; shared deadline covers download and decode.
const urls=['/arena/assets/match-palace-mobile-09ad602636.webp','/arena/assets/restoration/gems-v2.webp','/arena/assets/restoration/fox-idle-v3.webp','/arena/assets/restoration/fox-cheer-v3.webp','/arena/assets/restoration/player-portraits-v2-mobile-e193e8ea76.webp'];
export const preloadMatchAssets=()=>preloadImages(urls);
