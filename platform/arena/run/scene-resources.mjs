/** Scene-owned GPU objects. Cached source assets are never handed to a renderer. */
export function createRunSceneResources(){
 const geometries=new Map(),materials=new Map(),textures=new Map();let disposed=false;
 const texture=source=>{if(!source)return source;if(disposed)throw Error('Run scene resources already disposed');if(!textures.has(source)){const value=source.clone();value.needsUpdate=true;textures.set(source,value);}return textures.get(source);};
 const material=source=>{if(!source)return source;if(!materials.has(source)){const value=source.clone();for(const key of Object.keys(value))if(value[key]?.isTexture)value[key]=texture(value[key]);materials.set(source,value);}return materials.get(source);};
 return{
  texture,
  ownTree(root){if(disposed)throw Error('Run scene resources already disposed');root.traverse(object=>{if(!object.isMesh)return;if(!geometries.has(object.geometry))geometries.set(object.geometry,object.geometry.clone());object.geometry=geometries.get(object.geometry);object.material=Array.isArray(object.material)?object.material.map(material):material(object.material);});return root;},
  counts(){return{geometries:geometries.size,materials:materials.size,textures:textures.size,disposed};},
  dispose(){if(disposed)return;disposed=true;for(const value of geometries.values())value.dispose();for(const value of materials.values())value.dispose();for(const value of textures.values())value.dispose();geometries.clear();materials.clear();textures.clear();},
 };
}
