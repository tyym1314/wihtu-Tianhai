/** Display-only surface shading. Does not supply geometry or physics. */
const noiseGLSL=`
 varying vec3 vOasisWorld;
 float oasisHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
 float oasisNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(oasisHash(i),oasisHash(i+vec2(1,0)),f.x),mix(oasisHash(i+vec2(0,1)),oasisHash(i+vec2(1,1)),f.x),f.y);}
`;
export function softenSurface(material,kind){
 material.onBeforeCompile=shader=>{
  shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vOasisWorld;').replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
   vec4 oasisWorld = vec4(transformed,1.0);
   #ifdef USE_INSTANCING
   oasisWorld = instanceMatrix * oasisWorld;
   #endif
   vOasisWorld = (modelMatrix * oasisWorld).xyz;
  `);
  shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+noiseGLSL);
  if(kind==='stone'||kind==='grass')shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`
   #ifdef USE_MAP
    vec2 oasisUV=vMapUv;
    vec2 oasisUV2=mat2(.7986,-.6018,.6018,.7986)*oasisUV*1.371+vec2(3.77,7.19);
    vec4 a=texture2D(map,oasisUV),b=texture2D(map,oasisUV2);
    vec3 surface=mix(a.rgb,b.rgb,.43);
    float macro=oasisNoise(vOasisWorld.xz*.34+vec2(vOasisWorld.y*.29));
    ${kind==='grass'?`surface*=mix(.92,1.12,macro);`:`surface*=mix(.87,1.08,macro);float wet=1.-smoothstep(-.86,-.15,vOasisWorld.y);surface=mix(surface,surface*vec3(.53,.64,.64),wet*.75);float moss=smoothstep(.48,.74,oasisNoise(vOasisWorld.xz*2.1))*(1.-smoothstep(-.1,.22,vOasisWorld.y));surface*=mix(vec3(1.),vec3(.68,.83,.62),moss*.34);`}
    diffuseColor.rgb*=surface;
   #endif
  `);
  if(kind==='leaf')shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`
   // Thin living leaves transmit warm sky light; local normals still preserve each cambered blade.
   float rim=pow(1.-abs(dot(normal,geometryViewDir)),2.0);
   float crown=oasisNoise(vOasisWorld.xz*1.25);
   outgoingLight+=diffuseColor.rgb*vec3(.82,.76,.30)*(.045+rim*.34)*( .8+crown*.4);
   #include <opaque_fragment>
  `);
 };
 material.customProgramCacheKey=()=>`oasis-living-surface-v2-${kind}`;
 material.needsUpdate=true;
 return material;
}
