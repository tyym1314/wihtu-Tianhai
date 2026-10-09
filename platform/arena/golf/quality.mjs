/** Keep loader and renderer tiers identical, including a narrow desktop window. */
export function golfMobileQuality(){return typeof window!=='undefined'&&((window.matchMedia?.('(pointer: coarse)').matches)||Math.min(window.innerWidth,window.innerHeight)<=600);}
