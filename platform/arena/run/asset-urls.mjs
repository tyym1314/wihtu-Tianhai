import foxRun from './assets/atlases/run-fox-v4-mobile-bd3571fd7e.webp?url';
import catRun from './assets/atlases/run-cat-v4-mobile-e8ac410768.webp?url';
import bearRun from './assets/atlases/run-bear-v4-mobile-9b7c40a00c.webp?url';
import rabbitRun from './assets/atlases/run-rabbit-v4-mobile-415ab8b203.webp?url';
import action from './assets/atlases/action-back-mobile-81e5c62e42.webp?url';
import front from './assets/atlases/front-win-mobile-902055527a.webp?url';
import kit from './assets/environment/oasis-kit-runtime-v1.glb?url';
import albedo from '../golf/assets/textures/aged-sandstone-imagegen-mobile-dcc28108d4.webp?url';
import normal from '../golf/assets/textures/sandstone-normal.webp?url';
import backdrop from '../golf/assets/textures/oasis-distant-palace-mobile-e251f780d8.webp?url';
import {selectRunPreloadKinds} from './asset-selection.mjs';

export const RUN_CYCLE_URLS={fox:foxRun,cat:catRun,bear:bearRun,rabbit:rabbitRun};
export const RUN_ATLAS_URLS={run:foxRun,action,front};
export const RUN_ENVIRONMENT_URLS={kit,albedo,normal,backdrop};
export function runAssetSourcePlan(kinds){
 return{images:[...selectRunPreloadKinds(kinds).map(kind=>RUN_CYCLE_URLS[kind]),action,front,albedo,normal,backdrop],models:[kit]};
}
