"""Editable original Oasis art; run with Blender 4.5 --background --python build_oasis.py.
Coordinates come from read-only engine topology snapshot. No gameplay modification.
"""
import bpy, math, random, json, os
from mathutils import Vector
from mathutils.noise import noise_vector
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
random.seed(1978)
MODELS=os.path.join(ROOT,'models'); TEXTURES=os.path.join(ROOT,'textures')
os.makedirs(MODELS,exist_ok=True);os.makedirs(TEXTURES,exist_ok=True)
def clean():
 bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
def xyz(p):return(p[0],-p[2],p[1])
def material(name,color,rough=.7,metal=0):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True;s=m.node_tree.nodes.get('Principled BSDF');s.inputs['Base Color'].default_value=(*color,1);s.inputs['Roughness'].default_value=rough;s.inputs['Metallic'].default_value=metal;return m
def mesh(name,v,f,mat,smooth=False):
 data=bpy.data.meshes.new(name);data.from_pydata([xyz(p) for p in v],[],f);data.materials.append(mat);data.update();o=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(o)
 if smooth:
  for p in data.polygons:p.use_smooth=True
 return o
def bevel(o,width=.025,segments=2):
 m=o.modifiers.new('Hand softened edges','BEVEL');m.width=width;m.segments=segments
 bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=m.name)
 return o
def cube(name,pos,scale,mat,bev=.02):
 bpy.ops.mesh.primitive_cube_add(size=1,location=xyz(pos));o=bpy.context.object;o.name=name;o.scale=(scale[0],scale[2],scale[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(mat)
 if bev:bevel(o,bev)
 return o
def sphere(name,pos,r,mat,scale=(1,1,1),segments=16,rings=10):
 if segments<=8:bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=r,location=xyz(pos))
 else:bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=rings,radius=r,location=xyz(pos))
 o=bpy.context.object;o.name=name;o.scale=(scale[0],scale[2],scale[1]);o.data.materials.append(mat)
 for p in o.data.polygons:p.use_smooth=True
 return o
def join(name,objects):
 bpy.ops.object.select_all(action='DESELECT')
 for o in objects:o.select_set(True)
 bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join();o=bpy.context.object;o.name=name;return o
def parent(name,objects):
 root=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(root)
 for o in objects:o.parent=root
 return root
def export(name):
 bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT,'source',name+'.blend'))
 bpy.ops.export_scene.gltf(filepath=os.path.join(MODELS,name+'.glb'),export_format='GLB',export_draco_mesh_compression_enable=True,export_draco_mesh_compression_level=6,export_draco_position_quantization=14,export_yup=True,export_apply=True,export_extras=True)
 print('ART_EXPORTED',name,sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH'))
# Original PBR maps, authored numerically in Blender and preserved alongside native scene.
import numpy as np
N=512;yy,xx=np.mgrid[0:N,0:N];rng=np.random.default_rng(1978)
noise=rng.random((N,N));vein=np.sin(xx*.056+np.sin(yy*.028)*3)+np.sin(yy*.071+xx*.013)
def image_map(name,rgb):
 rgba=np.ones((N,N,4),dtype=np.float32);rgba[:,:,:3]=np.clip(rgb,0,1);im=bpy.data.images.new(name,width=N,height=N);im.pixels.foreach_set(rgba.ravel());im.filepath_raw=os.path.join(TEXTURES,name+'.png');im.file_format='PNG';im.save();return im
stone_height=noise*.24+(np.sin(xx*.02+yy*.014)+1)*.15
stone_rgb=np.stack([.70+stone_height*.12,.57+stone_height*.12,.40+stone_height*.15],axis=-1)+vein[:,:,None]*.012
stone_map=image_map('sandstone-albedo',stone_rgb)
grass_noise=rng.random((N,N));grass_rgb=np.stack([.19+grass_noise*.10,.36+grass_noise*.15,.075+grass_noise*.08],axis=-1);grass_map=image_map('fine-grass-albedo',grass_rgb)
dy,dx=np.gradient(stone_height);normal=np.stack([.5-dx*.8,.5-dy*.8,np.ones_like(dx)],axis=-1);image_map('sandstone-normal',normal)
dy,dx=np.gradient(grass_noise);image_map('fine-grass-normal',np.stack([.5-dx*.38,.5-dy*.38,np.ones_like(dx)],axis=-1))
stone=[material('Oasis sandstone '+str(i),(.72+i*.009,.62+i*.008,.46+i*.008),.91) for i in range(7)]
cap=material('Sunlit cream coping',(.88,.76,.56),.77);grass=material('Meadow turf',(.29,.47,.11),.9);gold=material('Warm architectural brass',(.79,.54,.18),.27,.76);teal=material('Turquoise ceramic inlay',(.055,.31,.35),.34,.22)
leafm=[material('Living palm leaf '+str(i),c,.7) for i,c in enumerate([(.10,.23,.025),(.23,.38,.055),(.36,.48,.12)])];bark=material('Fibrous palm bark',(.32,.21,.11),.94);pink=material('Bougainvillea magenta',(.79,.08,.29),.8);yellow=material('Small ivory flowers',(.97,.75,.35),.74);fernmat=material('Broad tropical leaf',(.13,.30,.045),.67)
def trunk_and_crown():
 objs=[];v=[];f=[]
 for j in range(28):
  t=j/27;cx=.28*t*t;cz=.1*t;r=.16*(1-.45*t)*(1+.12*math.sin(j*2.8))
  for k in range(12):a=k*math.tau/12;v.append((cx+math.cos(a)*r,3.25*t,cz+math.sin(a)*r))
 for j in range(27):
  for k in range(12):a=j*12+k;b=j*12+(k+1)%12;f.append((a,a+12,b+12,b))
 objs.append(mesh('PalmTrunk',v,f,bark,True));leaves=[]
 for q in range(19):
  angle=q*2.39996;inner=q>=11;length=(1.27 if inner else 2.1)+(q%3)*.14;v=[];f=[]
  def centerline(t):
   return Vector((.28+math.cos(angle)*length*t,3.22+(1.05 if inner else .62)*math.sin(t*math.pi)-t*(.08 if inner else 1.04),.1+math.sin(angle)*length*t))
  # Each leaflet has a cambered center rib and a narrow tapered tip, not flat ladder bars.
  for n in range(1,23):
   t=n/24;center=centerline(t);w=.48*math.sin(t*math.pi)**.74*(.92+.08*math.sin(n*2.4+q));along=Vector((math.cos(angle),0,math.sin(angle)))
   for side in [-1,1]:
    cross=Vector((-math.sin(angle),-.15,math.cos(angle)))*side
    mid=center+cross*w*.53+along*.065+Vector((0,.048,0));tip=center+cross*w+along*(.19+.045*math.sin(n+q))+Vector((0,-.07,0));half=.038*math.sin(t*math.pi)**.3
    k=len(v);v.extend([tuple(center-along*.015),tuple(mid-along*half),tuple(mid+Vector((0,.026,0))),tuple(mid+along*half),tuple(tip)]);f.extend([(k,k+1,k+2),(k,k+2,k+3),(k+1,k+4,k+2),(k+2,k+4,k+3)])
  # Tapered rachis makes the frond's curvature readable under warm side light.
  for n in range(20):
   t=n/19;c=centerline(t);r=.014*(1-t)+.003
   for k in range(3):
    a=k*math.tau/3;v.append(tuple(c+Vector((-math.sin(angle)*math.cos(a)*r,math.sin(a)*r,math.cos(angle)*math.cos(a)*r))))
   if n<19:
    base=len(v)-3
    for k in range(3):f.append((base+k,base+(k+1)%3,base+3+(k+1)%3,base+3+k))
  leaves.append(mesh('Palm frond '+str(q),v,f,leafm[q%3],True))
 crown=join('PalmCrown',leaves);objs.append(crown)
 for i in range(7):objs.append(sphere('Coconut',(.28+math.cos(i)*.15,3.05,.1+math.sin(i)*.15),.12,bark))
 trunk=join('PalmTrunk',[o for o in objs if o!=crown]);return parent('Palm',[trunk,crown])
def flower_cluster():
 objs=[]
 for i in range(23):
  a=i*2.399;r=.45*math.sqrt((i+.5)/23);x=math.cos(a)*r;z=math.sin(a)*r;y=.12+.30*random.random()
  for j in range(3):
   t=j*math.tau/3;objs.append(sphere('Leaf',(x+math.cos(t)*.10,y*.55,z+math.sin(t)*.1),.12,leafm[1],(.75,.35,1.8),8,5))
  for j in range(5):
   t=j*math.tau/5;objs.append(sphere('Petal',(x+math.cos(t)*.055,y,z+math.sin(t)*.055),.055,pink if i%3 else yellow,(1,.32,1.2),8,5))
  objs.append(sphere('Pollen',(x,y+.015,z),.025,yellow,segments=8,rings=5))
 return join('Flowers',objs)
def fern():
 v=[];f=[]
 for j in range(11):
  a=j*2.399;length=.5+(j%4)*.11
  for k in range(10):
   t=k/9;r=length*t;w=.15*math.sin(t*math.pi);y=.42*math.sin(t*2.0)
   for side in [-1,0,1]:v.append((math.cos(a)*r-math.sin(a)*w*side,y+(1-abs(side))*.035,math.sin(a)*r+math.cos(a)*w*side))
   if k<9:
    n=j*30+k*3;f.extend([(n,n+1,n+4,n+3),(n+1,n+2,n+5,n+4)])
 return mesh('Fern',v,f,fernmat,True)
clean();trunk_and_crown();flower_cluster();fern();export('oasis-botanical-library')
levels=json.load(open(os.path.join(ROOT,'source','course-topology.json')))
def island(points,top=.15,depth=2.2,label='Island'):
 count=len(points);v=[];f=[];area=sum(p['x']*points[(i+1)%count]['z']-points[(i+1)%count]['x']*p['z']for i,p in enumerate(points));sign=1 if area<0 else -1;rows=10
 # Continuous eroded rock volume; smooth strata and undercuts replace random faceted patchwork.
 for row in range(rows):
  t=row/(rows-1)
  for i,p in enumerate(points):
   a=points[(i-1)%count];b=points[(i+1)%count];dx=b['x']-a['x'];dz=b['z']-a['z'];length=math.hypot(dx,dz) or 1;nx=-dz/length*sign;nz=dx/length*sign
   n=noise_vector(Vector((p['x']*.85,t*2.7,p['z']*.85)));erosion=.09*n.x+.08*math.sin(t*14+p['x']*.52+p['z']*.47)
   offset=.06+.06*math.sin(t*math.pi)+erosion*.55*math.sin(t*math.pi)**.4
   v.append((p['x']+nx*offset,top-t*depth+(n.z*.045 if row else 0),p['z']+nz*offset))
 for row in range(rows-1):
  for i in range(count):j=(i+1)%count;f.append((row*count+i,row*count+j,(row+1)*count+j,(row+1)*count+i))
 o=mesh(label+' continuous weathered strata',v,f,stone[2],True)
 # Uneven individual hand-dressed facing stones retain joints, with soft corners and coherent colors.
 for row in range(3):
  for i in range(0,count,4):
   a=points[i];b=points[(i+4)%count];dx=b['x']-a['x'];dz=b['z']-a['z'];length=math.hypot(dx,dz)
   if length<.08:continue
   nx=-dz/length*sign;nz=dx/length*sign
   block=cube(label+' rounded limestone',((a['x']+b['x'])/2+nx*.075,top-.33-row*.59+math.sin(i*.83+row)*.035,(a['z']+b['z'])/2+nz*.075),(max(.055,length-.035),.55+math.sin(i*.7+row)*.035,.34),stone[(i//12+row)%7],.04)
   # Low-frequency weathering rounds the sculpture without moving any authoritative inside edge.
   for vert in block.data.vertices:
    n=noise_vector(vert.co*3.1+Vector((i*.47,row*.61,1.7)))
    vert.co.x+=n.x*.012;vert.co.y+=n.y*.019;vert.co.z+=n.z*.014
   block.rotation_euler.z=-math.atan2(dz,dx)
   for face in block.data.polygons:face.use_smooth=True
   weighted=block.modifiers.new('Weathered weighted normals','WEIGHTED_NORMAL');weighted.keep_sharp=True;weighted.weight=35
   bpy.context.view_layer.objects.active=block;bpy.ops.object.modifier_apply(modifier=weighted.name)

 return o
for index,level in enumerate(levels):
 clean();island(level['polygon'],label='Playable coastline')
 for n,e in enumerate(level['walls']):
  if not e['solid']:continue
  a=e['a'];b=e['b'];dx=b['x']-a['x'];dz=b['z']-a['z'];length=math.hypot(dx,dz)
  o=cube('Legal stone curb',((a['x']+b['x'])/2-dz/length*.09,.29,(a['z']+b['z'])/2+dx/length*.09),(length+.024,.24,.36),cap,.016);o.rotation_euler.z=-math.atan2(dz,dx)
 # Authored arch, no flat lintel across its curved crown.
 s=level['samples'][int(len(level['samples'])*level['bridgeAt'])];width=s['width']+.25;ang=-math.atan2(s['nz'],s['nx'])
 def bridgepos(x,y,z):return(s['x']+math.cos(ang)*x+math.sin(ang)*z,y,s['z']-math.sin(ang)*x+math.cos(ang)*z)
 for j in range(23):
  a=math.pi*j/23;b=math.pi*(j+1)/23;v=[]
  for z in [-.24,.24]:
   for r,h,t in [(width+.19,1.73,a),(width+.19,1.73,b),(width-.10,1.43,b),(width-.10,1.43,a)]:v.append(bridgepos(math.cos(t)*r,.22+math.sin(t)*h,z))
  o=mesh('Bridge carved voussoir '+str(j),v,[(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)],stone[3+j%3]);bevel(o,.015)
  if j%2==1:
   t=(a+b)/2;pos=bridgepos(math.cos(t)*width,.22+math.sin(t)*1.61,.265);inlay=sphere('Glazed turquoise arch tile',pos,.085,teal,(.7,1,.17),8,5)
 decor=[[-5,8,1.6,1],[4.9,5,1.55,.8],[-5.7,1,1.9,1.15],[4.8,-2,1.7,1.05],[-5.3,-6.4,2,1.2],[5.2,-10.5,2.5,1.5],[-6.7,-13.5,2.9,1.35]]
 for j,(x,z,r,scale) in enumerate(decor):
  ps=[{'x':x+math.cos(i*math.tau/72)*r*(1+.10*math.sin(i*math.tau/72*3+j)+.06*math.sin(i*math.tau/72*5-j*.4)),'z':z+math.sin(i*math.tau/72)*r*(1+.10*math.sin(i*math.tau/72*3+j)+.06*math.sin(i*math.tau/72*5-j*.4))} for i in range(72)];island(ps,.16,2.25,'Garden coast '+str(j))
 for progress in [.04,.18,.53,.76,.94]:
  q=level['samples'][int(progress*(len(level['samples'])-1))];side=-1 if progress>.5 else 1;x=q['x']+q['nx']*(q['width']+.6)*side;z=q['z']+q['nz']*(q['width']+.6)*side;ps=[{'x':x+math.cos(i*math.tau/20)*.75,'z':z+math.sin(i*math.tau/20)*.75} for i in range(20)];island(ps,.17,1.8,'Flower terrace')
 # Join by material to reduce mobile draw calls, while retaining editable individual parts in source collection backup.
 bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT,'source','oasis-course-'+str(index+1)+'-editable.blend'))
 pieces=[o for o in bpy.context.scene.objects if o.type=='MESH'];join('Oasis artisan masonry',pieces)
 export('oasis-course-'+str(index+1))
print('OASIS_BUILD_COMPLETE')
