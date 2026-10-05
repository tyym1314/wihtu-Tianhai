import {CHARACTERS} from './level.mjs';

/** Match the renderer's unknown-character fallback and avoid duplicate preloads. */
export function selectRunPreloadKinds(kinds=CHARACTERS){
 if(!Array.isArray(kinds))throw new TypeError('Run preload kinds must be an array');
 return [...new Set(kinds.map(kind=>CHARACTERS.includes(kind)?kind:'fox'))];
}
