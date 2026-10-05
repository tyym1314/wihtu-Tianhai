"""Editable modular oasis scenery authored in Blender; no gameplay geometry changes."""
import bpy,math,random,pathlib,json
from mathutils import Vector
P=pathlib.Path(__file__).resolve().parents[1];OUT=P/'environment';OUT.mkdir(exist_ok=True);R=random.Random(491)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
def mat(name,col,rough=.75,metal=0):
 m=bpy.data.materials.new(name);m.use_nodes=True;bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(*col,1);bs.inputs['Roughness'].default_value=rough;bs.inputs['Metallic'].default_value=metal;return m
stone=mat('Pale warm sandstone',(.60,.43,.25));edge=mat('Sunlit sandstone',(.76,.58,.36));darkstone=mat('Weathered stone',(.43,.30,.18));leaf=mat('Date palm green',(.065,.20,.10));leaf2=mat('Young palm leaf',(.13,.30,.12));trunk=mat('Palm bark',(.28,.17,.08));gold=mat('Aged golden brass',(.59,.35,.08),.32,.63);teal=mat('Oasis turquoise glazed tile',(.012,.25,.25),.33,.3);cloth=mat('Teal embroidered banners',(.025,.20,.21),.76);shadow=mat('Recessed window',(.034,.087,.089));cream=mat('Pale lime grout',(.82,.67,.45));roots=[];parts=[]
def begin(name):
 global parts;parts=[];root=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(root);roots.append(root);return root
def mesh(name,verts,faces,material):
 data=bpy.data.meshes.new(name);data.from_pydata(verts,[],faces);data.update();o=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(o);o.data.materials.append(material);parts.append(o)
 for p in data.polygons:p.use_smooth=True
 return o
def finish(root):
 # Material batches keep repeated modular scenery inexpensive in WebGL.
 batches={material:[o for o in parts if o.data.materials[0]==material] for material in [stone,edge,darkstone,leaf,leaf2,trunk,gold,teal,cloth,shadow,cream]}
 for material,batch in batches.items():
  if not batch:continue
  bpy.ops.object.select_all(action='DESELECT')
  for o in batch:o.select_set(True)
  bpy.context.view_layer.objects.active=batch[0];bpy.ops.object.join();o=bpy.context.object;o.name=root.name+'_'+material.name;o.parent=root
 return root

def box(name,pos,scale,material,bevel=.035):
 bpy.ops.mesh.primitive_cube_add(size=1,location=pos);o=bpy.context.object;o.name=name;o.dimensions=scale;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(material)
 if bevel:
  mod=o.modifiers.new('Worn softened edges','BEVEL');mod.width=bevel;mod.segments=2;bpy.ops.object.modifier_apply(modifier=mod.name)
 for p in o.data.polygons:p.use_smooth=False
 parts.append(o);return o

def tube(name,pts,radius,material,segments=10):
 verts=[];faces=[]
 for j,p0 in enumerate(pts):
  p=Vector(p0);t=(Vector(pts[min(j+1,len(pts)-1)])-Vector(pts[max(j-1,0)])).normalized();u=t.cross(Vector((0,0,1)))
  if u.length<.1:u=t.cross(Vector((0,1,0)))
  u.normalize();v=t.cross(u).normalized();r=radius[j] if isinstance(radius,list) else radius
  for i in range(segments):
   q=p+r*(u*math.cos(i/segments*math.tau)+v*math.sin(i/segments*math.tau));verts.append(tuple(q))
 for j in range(len(pts)-1):
  for i in range(segments):a=j*segments+i;b=j*segments+(i+1)%segments;faces.append((a,b,b+segments,a+segments))
 return mesh(name,verts,faces,material)
def lathe(name,profile,material,pos=(0,0,0),segments=32):
 verts=[];faces=[]
 for r,z in profile:
  for i in range(segments):verts.append((pos[0]+r*math.cos(i/segments*math.tau),pos[1]+r*math.sin(i/segments*math.tau),pos[2]+z))
 for j in range(len(profile)-1):
  for i in range(segments):a=j*segments+i;b=j*segments+(i+1)%segments;faces.append((a,b,b+segments,a+segments))
 return mesh(name,verts,faces,material)
def arch_outline(cx,cy,z,width,height,depth,material):
 pts=[(cx-width,cy,z),(cx-width,cy,z+height-width)];pts.extend((cx+math.cos(math.pi-i/20*math.pi)*width,cy,z+height-width+math.sin(math.pi-i/20*math.pi)*width) for i in range(21));pts.append((cx+width,cy,z));return tube('Carved arch surround',pts,depth,material,8)
# Palm: continuous bent trunk, bark scars and pinnate leaflets, not ellipsoid leaves.
r=begin('Palm')
trunkpts=[(.025*i+.016*i*i,0,i*.32) for i in range(12)];tube('Curved date palm trunk',trunkpts,[.15-i*.004 for i in range(12)],trunk,12)
for i in range(15):
 z=.18+i*.215;x=.025*(z/.32)+.016*(z/.32)**2;ring=[(x+math.cos(j/18*math.tau)*.151,math.sin(j/18*math.tau)*.151,z+.032*math.sin(j/18*math.tau)) for j in range(19)];tube('Bark growth scar',ring,.016,darkstone,6)
top=Vector(trunkpts[-1])
for k in range(19):
 a=k/19*math.tau;direction=Vector((math.cos(a),math.sin(a),0));side=Vector((-math.sin(a),math.cos(a),0));length=1.95+(k%3)*.13;pts=[]
 for j in range(13):
  t=j/12;pts.append(tuple(top+direction*(length*t)+Vector((0,0,.46*math.sin(t*math.pi)-.72*t*t))))
 tube('Palm frond midrib',pts,[.017*(1-j/14) for j in range(13)],leaf,6)
 for j in range(1,12):
  t=j/12;c=Vector(pts[j]);w=.53*math.sin(t*math.pi)**.7
  for sign in [-1,1]:
   tip=c+side*w*sign-direction*.15+Vector((0,0,-.09));mid=(c+tip)/2+Vector((0,0,.025));v=[tuple(c-direction*.041),tuple(c+direction*.041),tuple(mid+direction*.075),tuple(tip),tuple(mid-direction*.075)];mesh('Individual palm leaflet',v,[(0,1,2),(0,2,4),(4,2,3)],leaf if (j+k)%3 else leaf2)
for k in range(4):lathe('Dates cluster',[(0,-.12),(.09,-.07),(.1,.06),(.025,.13),(0,.14)],trunk,tuple(top+Vector((math.cos(k)*.13,math.sin(k)*.13,-.15))),12)
finish(r)
# Individual rocky bank, with softened tessellated stone surface and shallow grass terrace.
r=begin('RockBank');verts=[];faces=[];segments=56;levels=[(-2.6,.68),(-2.3,.79),(-1.95,.97),(-1.64,.93),(-1.28,1.04),(-.94,1.02),(-.65,.98),(-.33,.99),(0,.83)]
for j,(z,rad) in enumerate(levels):
 for i in range(segments):a=i/segments*math.tau;rr=rad*(1+.085*math.sin(a*5+j*.6)+.055*math.cos(a*11+j*1.7)+.035*math.sin(a*19+j*.4));verts.append((math.cos(a)*rr*2.5,math.sin(a)*rr*1.8,z+.08*math.sin(a*3+j)))
for j in range(len(levels)-1):
 for i in range(segments):a=j*segments+i;b=j*segments+(i+1)%segments;faces.append((a,b,b+segments,a+segments))
faces.append(tuple(range((len(levels)-1)*segments,len(levels)*segments)));bank=mesh('Natural sandstone riverbank',verts,faces,stone);bank.data.materials.append(edge);bank.data.materials.append(darkstone)
for f in bank.data.polygons:
 f.use_smooth=False;f.material_index=1 if f.index//segments in [2,5] else 0
uv=bank.data.uv_layers.new(name='Stone strata UV')
for poly in bank.data.polygons:
 for li in poly.loop_indices:
  co=bank.data.vertices[bank.data.loops[li].vertex_index].co;uv.data[li].uv=((co.x+2.5)/5,(co.z+2.6)/2.6)
for i in range(12):a=i/math.pi*.9;box('Bank rim boulder',(math.cos(a)*1.85,math.sin(a)*1.38,-.14),(R.uniform(.28,.56),R.uniform(.3,.52),R.uniform(.17,.31)),edge,.065)
finish(r)
# Supporting arches fit underneath the unchanged straight authoritative three-lane deck.
r=begin('BridgeSupport')
for side in [-1,1]:
 for y in [-2.5,2.5]:
  for row in range(5):box('Bridge pier ashlar',(side*2.10,y,-2.82+row*.46),(.62,1.0,.44),stone if row%2 else edge,.045)
 for i in range(14):
  a=(i+.5)/14*math.pi;cx=math.cos(a)*2.06;z=-2.6+math.sin(a)*1.92;o=box('Arch voussoir',(side*2.10,cx,z),(.62,.49,.47),edge if i==6 else stone,.03);o.rotation_euler[0]=math.pi/2-a
 box('Bridge cornice',(side*2.10,0,-.20),(.69,6.1,.23),edge,.055)
finish(r)
# A facade with balconies, deep arch windows, tiled onion dome and small minarets.
r=begin('Palace')
box('Foundation',(0,0,.15),(5.8,4.3,.5),darkstone,.1)
box('Main sandstone hall',(0,0,1.7),(4.7,3.5,3.4),stone,.12)
for z in [.5,1.15,1.80,2.45,3.10,3.48]:box('Wall course moulding',(0,0,z),(4.78,3.58,.06),edge,.018)
for side in [-1,1]:
 for x in [-1.55,0,1.55]:
  y=side*1.766;verts=[(x-.35,y,.95),(x+.35,y,.95),(x+.35,y,1.85)];verts.extend((x+math.cos(a)*.35,y,1.85+math.sin(a)*.35) for a in [i/16*math.pi for i in range(17)]);mesh('Deep arched window',verts,[tuple(range(len(verts)))],shadow);arch_outline(x,y+side*.024,.9,.41,1.39,.060,edge)
  box('Carved window sill',(x,y+side*.09,.92),(.94,.24,.10),edge,.025)
 for x in [-2.2,2.2]:
  lathe('Palace corner tower',[(.43,0),(.43,3.7),(.50,3.75),(.50,3.95),(.31,4.0),(.31,4.35),(.46,4.42),(.43,4.7),(.1,5.10),(0,5.15)],stone,(x,side*1.5,0),24)
  lathe('Tower brass finial',[(.03,0),(.03,.33),(.07,.38),(0,.49)],gold,(x,side*1.5,5.10),16)
lathe('Turquoise onion dome',[(1.42,0),(1.43,.2),(1.31,.50),(1.07,.85),(.62,1.12),(.28,1.42),(.10,1.65),(0,1.72)],teal,(0,0,3.4),40)
for i in range(12):a=i/12*math.tau;pts=[(r*math.cos(a),r*math.sin(a),3.4+z) for r,z in [(1.44,.05),(1.45,.2),(1.33,.5),(1.09,.85),(.64,1.12),(.3,1.42),(.12,1.65)]];tube('Golden dome rib',pts,.012,gold,6)
lathe('Dome top finial',[(.04,0),(.04,.32),(.09,.38),(0,.52)],gold,(0,0,5.1),16)
for side in [-1,1]:
 for j in range(11):box('Roof crenellation',(-2.1+j*.42,side*1.69,3.67),(.24,.28,.36),edge,.025)
finish(r)
# Finish gate with literal 3D cloth, embroidered banners, keystones and architectural columns.
r=begin('FinishGate')
for side in [-1,1]:
 for row in range(9):box('Finish column block',(side*2.40,0,.23+row*.44),(.66,.78,.415),stone if row%3 else edge,.05)
 box('Column capital',(side*2.40,0,4.10),(.93,1.0,.28),edge,.07)
 box('Column base',(side*2.40,0,.10),(.95,1.02,.20),edge,.055)
 # Hanging pennant with a pointed end, slightly bowed forward.
 v=[(side*2.4-.23,-.43,3.7),(side*2.4+.23,-.43,3.7),(side*2.4+.23,-.47,2.15),(side*2.4,-.52,1.86),(side*2.4-.23,-.47,2.15)];mesh('Silk gate pennant',v,[(0,1,2,3,4)],cloth)
 for j in range(5):
  z=2.2+j*.23;tube('Laurel pennant embroidery',[(side*2.4,-.53,z),(side*2.4-.12,-.53,z+.13),(side*2.4-.13,-.53,z+.19)],.015,gold,6);tube('Laurel pennant embroidery',[(side*2.4,-.53,z),(side*2.4+.12,-.53,z+.13),(side*2.4+.13,-.53,z+.19)],.015,gold,6)
box('Finish arch beam',(0,0,3.99),(4.9,.65,.46),edge,.08)
verts=[];faces=[]
for j in range(18):
 x=-2.06+j/17*4.12;verts.extend([(x,-.35,3.72+.025*math.sin(j*.5)),(x,-.35-.05*math.sin(j*.7),3.02+.04*math.sin(j*.7))])
for j in range(17):a=j*2;faces.append((a,a+1,a+3,a+2))
mesh('Finish silk banner',verts,faces,cloth)
bpy.ops.object.text_add(location=(0,-.42,3.25),rotation=(math.pi/2,0,0));txt=bpy.context.object;txt.data.body='FINISH';txt.data.align_x='CENTER';txt.data.size=.46;txt.data.extrude=.008;txt.data.materials.append(cream);bpy.ops.object.convert(target='MESH');parts.append(bpy.context.object)
finish(r)
# Save an editable workbench with named prefabs separated. Export resets only root placements.
for i,r in enumerate(roots):r.location.x=i*8
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'oasis-modular-environment.blend'))
for r in roots:r.location=(0,0,0)
bpy.ops.object.select_all(action='SELECT');bpy.ops.export_scene.gltf(filepath=str(OUT/'oasis-kit.glb'),export_format='GLB',export_animations=False,export_yup=True)
meta={'prefabs':[r.name for r in roots],'source':'Original Blender modular meshes; cosmetic only','glb':'oasis-kit.glb','blend':'oasis-modular-environment.blend','triangles':sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.data.objects if o.type=='MESH')};(OUT/'manifest.json').write_text(json.dumps(meta,indent=2)+'\n');print('ENVIRONMENT_DONE',json.dumps(meta))
