import {UnrealBloomPass} from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
/** Preserve the complete five-mip HDR glow. Only regenerate its small texture
 * on capture frames; every display frame still blends it over the current lane.
 * Three r180's final additive stage is deliberately retained here. Screen/mask
 * configurations fall back to the upstream pass instead of caching them.
 */
export class CachedBowlingBloomPass extends UnrealBloomPass{
 capture=true;cacheReady=false;captureCount=0;
 setSize(width,height){super.setSize(width,height);this.cacheReady=false;}
 render(renderer,writeBuffer,readBuffer,deltaTime,maskActive){
  if(this.capture||!this.cacheReady||maskActive||this.renderToScreen){
   super.render(renderer,writeBuffer,readBuffer,deltaTime,maskActive);
   this.cacheReady=true;this.captureCount++;return;
  }
  const autoClear=renderer.autoClear;
  try{
   renderer.autoClear=false;
   this._fsQuad.material=this.blendMaterial;
   this.copyUniforms.tDiffuse.value=this.renderTargetsHorizontal[0].texture;
   renderer.setRenderTarget(readBuffer);
   this._fsQuad.render(renderer);
  }finally{renderer.autoClear=autoClear;}
 }
}
