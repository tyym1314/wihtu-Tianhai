"""Original Dune Dash character production: Blender 4.5, rigged GLB + editable blend.
Run with Blender -b --python thisfile -- --only fox (or omit --only).
All meshes/materials/UVs/weights/actions are generated deterministically here.
Coordinate convention: Blender Z up, character faces -Y, feet at z=0.
"""
import bpy, math, random, json, pathlib, sys, argparse
import numpy as np
from mathutils import Vector, Matrix
P=pathlib.Path(__file__).resolve().parents[1]
OUT=P/'characters'; OUT.mkdir(exist_ok=True)
parser=argparse.ArgumentParser();parser.add_argument('--only');args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
R=random.Random(52091)
PARTS=[]
PALETTES={
 'fox':{'fur':'D5A05A','cream':'F2DFB5','cloth':'148C86','iris':'6B4425','inner':'D79985','height':1.0},
 'cat':{'fur':'252B34','cream':'485260','cloth':'B95349','iris':'86C849','inner':'AD797E','height':.94},
 'bear':{'fur':'956139','cream':'D3A875','cloth':'7552A0','iris':'623F20','inner':'AD7A64','height':1.04},
 'rabbit':{'fur':'E1DCD2','cream':'F6EDDC','cloth':'438DAC','iris':'5690B0','inner':'D69D9D','height':.97}}
def color(h):
 v=[int(h[i:i+2],16)/255 for i in (0,2,4)];return tuple(((x+.055)/1.055)**2.4 if x>.04045 else x/12.92 for x in v)+(1,)
def texture(name,kind='fur'):
 n=512; rng=np.random.default_rng(411 if kind=='fur' else 711)
 a=np.ones((n,n,4),dtype=np.float32);noise=rng.random((n,n))
 if kind=='fur':
  x=np.arange(n)[None,:];y=np.arange(n)[:,None];phase=x*.71+np.sin(y*.08+x*.023)*1.3
  hair=(np.sin(phase)*.5+.5)**9;strand=(np.sin(y*.11+x*.03)*.5+.5)
  value=.90+.065*noise+.035*hair*strand
 else:
  x=np.arange(n)[None,:];y=np.arange(n)[:,None];value=.87+.05*noise+.055*(np.sin(x*math.pi/2)*np.sin(y*math.pi/2))
 a[:,:,:3]=value[:,:,None];img=bpy.data.images.new(name,width=n,height=n,alpha=True);img.pixels.foreach_set(a.ravel());img.pack();return img
def material(name,hex,rough=.6,metal=0,tex=None):
 m=bpy.data.materials.new(name);m.use_nodes=True;bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=color(hex);bs.inputs['Roughness'].default_value=rough;bs.inputs['Metallic'].default_value=metal
 if tex:
  node=m.node_tree.nodes.new('ShaderNodeTexImage');node.image=tex
  mix=m.node_tree.nodes.new('ShaderNodeMixRGB');mix.blend_type='MULTIPLY';mix.inputs[0].default_value=1;mix.inputs[2].default_value=color(hex);m.node_tree.links.new(node.outputs['Color'],mix.inputs[1]);m.node_tree.links.new(mix.outputs[0],bs.inputs['Base Color'])
 # Diffuse silk sheen stays subtle; actual texture is baked below for glTF support.
 return m

def tinted_material(name,hex,rough,source):
 # Pack a directly connected, colorized albedo so GLB contains the same visible weave.
 base=np.array(source.pixels[:],dtype=np.float32).reshape(512,512,4)
 rgb=np.array([int(hex[i:i+2],16)/255 for i in (0,2,4)])
 base[:,:,:3]*=rgb;img=bpy.data.images.new(name+'_albedo',width=512,height=512,alpha=True);img.pixels.foreach_set(base.ravel());img.pack()
 m=material(name,'FFFFFF',rough);node=m.node_tree.nodes.new('ShaderNodeTexImage');node.image=img;m.node_tree.links.new(node.outputs['Color'],m.node_tree.nodes.get('Principled BSDF').inputs['Base Color']);return m

def obj_mesh(name,verts,faces,mat,bone='head',weights=None,uvs=None):
 mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.update();o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o);o.data.materials.append(mat)
 for p in mesh.polygons:p.use_smooth=True
 uv=mesh.uv_layers.new(name='UVMap')
 for poly in mesh.polygons:
  for li in poly.loop_indices:
   vi=mesh.loops[li].vertex_index
   uv.data[li].uv=uvs[vi] if uvs else ((verts[vi][0]+2)/4,(verts[vi][2]+.2)/2.8)
 groups={}
 for i,v in enumerate(verts):
  w=weights(i,Vector(v)) if weights else {bone:1}
  for b,value in w.items():
   if value<=0:continue
   if b not in groups:groups[b]=o.vertex_groups.new(name=b)
   groups[b].add([i],value,'REPLACE')
 PARTS.append(o);return o

def ellipsoid(name,center,scale,mat,bone='head',segments=32,rings=20,deform=None):
 verts=[];uv=[]
 for j in range(rings+1):
  t=j/rings;phi=t*math.pi
  for i in range(segments+1):
   u=i/segments;a=u*math.tau;q=Vector((math.sin(phi)*math.cos(a),math.sin(phi)*math.sin(a),math.cos(phi)))
   if deform:q=deform(q)
   verts.append((center[0]+q.x*scale[0],center[1]+q.y*scale[1],center[2]+q.z*scale[2]));uv.append((u,1-t))
 faces=[]
 for j in range(rings):
  for i in range(segments):
   a=j*(segments+1)+i;faces.append((a,a+1,a+segments+2,a+segments+1))
 return obj_mesh(name,verts,faces,mat,bone,uvs=uv)

def tube(name,points,radii,mat,bone='spine',segments=14,weight_fn=None):
 # Connected tapered sections, rather than separate ball-jointed limbs.
 verts=[];uv=[]
 for j,center in enumerate(points):
  p=Vector(center);a=Vector(points[max(0,j-1)]);b=Vector(points[min(len(points)-1,j+1)]);t=(b-a).normalized();side=t.cross(Vector((0,1,0)))
  if side.length<.1:side=t.cross(Vector((0,0,1)))
  side.normalize();other=t.cross(side).normalized();radius=radii[j] if isinstance(radii[j],tuple) else (radii[j],radii[j])
  for i in range(segments+1):
   angle=i/segments*math.tau;v=p+side*math.cos(angle)*radius[0]+other*math.sin(angle)*radius[1];verts.append(tuple(v));uv.append((i/segments,j/max(1,len(points)-1)))
 faces=[]
 for j in range(len(points)-1):
  for i in range(segments):
   a=j*(segments+1)+i;faces.append((a,a+1,a+segments+2,a+segments+1))
 faces.append(tuple(range(segments-1,-1,-1)));faces.append(tuple((len(points)-1)*(segments+1)+i for i in range(segments)))
 def weights(i,v):return weight_fn(i//(segments+1),v) if weight_fn else {bone:1}
 return obj_mesh(name,verts,faces,mat,bone,weights,uv)

def ribbon(name,points,widths,mat,bone):
 verts=[];uv=[]
 for j,p in enumerate(points):
  for side in [-1,1]:verts.append((p[0]+widths[j]*side,p[1],p[2]));uv.append(((side+1)/2,j/(len(points)-1)))
 faces=[(i*2,i*2+1,i*2+3,i*2+2) for i in range(len(points)-1)]
 o=obj_mesh(name,verts,faces,mat,bone,uvs=uv);sol=o.modifiers.new('Tailored cloth thickness','SOLIDIFY');sol.thickness=.015;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=sol.name);return o

def ear(name,base,height,width,tilt,fur,inner,bone,kind='fox'):
 verts=[];faces=[];uv=[];rows=24;cols=28
 # A hollow concave ear with an asymmetric rim; shaped and subdivided in geometry.
 for j in range(rows+1):
  t=j/rows;r=max(.003,(math.sin(math.pi*t)**.64 if kind=='rabbit' else (1-t)**.80*min(1,t/.13)**.4))*width
  for i in range(cols+1):
   a=i/cols*math.tau;x=r*math.cos(a);depth=(.064+.026*math.sin(math.pi*t))*math.sin(a)
   verts.append((base[0]+x+tilt*t,base[1]+depth+.06*t*t,base[2]+height*t));uv.append((i/cols,t))
 for j in range(rows):
  for i in range(cols):
   a=j*(cols+1)+i;faces.append((a,a+1,a+cols+2,a+cols+1))
 obj_mesh(name,verts,faces,fur,bone,uvs=uv)
 verts=[];faces=[];uv=[]
 for j in range(13):
  t=.13+j/12*.76;w=(math.sin(math.pi*t)**.7 if kind=='rabbit' else (1-t)**.8*min(1,t/.13)**.4)*width*.72
  for i in range(9):
   q=-1+i/4;verts.append((base[0]+q*w+tilt*t,base[1]-.087-.013*(1-q*q)+.06*t*t,base[2]+height*t));uv.append((i/8,j/12))
 for j in range(12):
  for i in range(8):a=j*9+i;faces.append((a,a+1,a+10,a+9))
 obj_mesh(name+'_velvet_inner',verts,faces,inner,bone,uvs=uv)

def rig_create():
 arm=bpy.data.armatures.new('DuneDash_Skeleton');rig=bpy.data.objects.new('DuneDash_Rig',arm);bpy.context.collection.objects.link(rig);bpy.context.view_layer.objects.active=rig;rig.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
 def bone(n,h,t,parent=None):
  b=arm.edit_bones.new(n);b.head=h;b.tail=t
  if parent:b.parent=arm.edit_bones[parent]
 bone('root',(0,0,0),(0,0,.18));bone('pelvis',(0,0,.52),(0,0,.76),'root');bone('spine',(0,0,.76),(0,0,1.10),'pelvis');bone('neck',(0,0,1.10),(0,0,1.27),'spine');bone('head',(0,0,1.27),(0,0,1.64),'neck');bone('jaw',(0,-.22,1.30),(0,-.4,1.24),'head')
 for side,suf in [(-1,'L'),(1,'R')]:
  bone('upper_arm.'+suf,(side*.29,0,1.02),(side*.42,0,.80),'spine');bone('forearm.'+suf,(side*.42,0,.80),(side*.40,-.02,.60),'upper_arm.'+suf);bone('hand.'+suf,(side*.40,-.02,.60),(side*.40,-.03,.49),'forearm.'+suf)
  bone('thigh.'+suf,(side*.155,0,.56),(side*.17,0,.31),'pelvis');bone('shin.'+suf,(side*.17,0,.31),(side*.17,-.035,.105),'thigh.'+suf);bone('foot.'+suf,(side*.17,-.035,.105),(side*.17,-.23,.085),'shin.'+suf)
  bone('ear.'+suf,(side*.28,.0,1.65),(side*.40,.01,2.18),'head');bone('eye.'+suf,(side*.19,-.29,1.49),(side*.19,-.29,1.57),'head');bone('scarf.'+suf,(side*.07,.16,1.12),(side*.12,.46,.94),'neck')
 bone('tail.0',(0,.10,.58),(0,.34,.62),'pelvis');bone('tail.1',(0,.34,.62),(0,.61,.82),'tail.0');bone('tail.2',(0,.61,.82),(0,.68,1.02),'tail.1')
 bpy.ops.object.mode_set(mode='OBJECT');rig.select_set(False)
 for p in rig.pose.bones:p.rotation_mode='XYZ'
 return rig

def make_character(kind):
 global PARTS;PARTS=[];R.seed(52091);bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
 for a in list(bpy.data.actions):bpy.data.actions.remove(a)
 p=PALETTES[kind];furtex=texture(kind+'_fur_grain');clothtex=texture(kind+'_cloth_weave','cloth')
 fur=tinted_material('Fur '+kind,p['fur'],.80,furtex);cream=tinted_material('Soft muzzle',p['cream'],.86,furtex);cloth=tinted_material('Tailored cloth',p['cloth'],.74,clothtex)
 inner=material('Ear velvet',p['inner'],.8);gold=material('Antique brass stitching','D5AC55',.34,.68);dark=material('Nose and eyelids','241B23',.39);mouth=material('Mouth cavity','492129',.85);pink=material('Tongue','D8838D',.56);white=material('Warm eye white','FFF3DA',.25);iris=material('Iris',p['iris'],.28);pupil=material('Pupil','100F14',.15);shine=material('Eye catchlight','FFFFFF',.07)
 # A continuous pear-shaped torso and pelvis, with shoulder and abdomen shaping.
 profile=[(.38,.14,.15),(.43,.23,.18),(.55,.285,.215),(.73,.30,.215),(.87,.265,.19),(1.0,.22,.16),(1.10,.145,.13),(1.15,.10,.09)]
 width=1.18 if kind=='bear' else .94 if kind=='rabbit' else 1
 pts=[(0,.02,z) for z,rx,ry in profile];rads=[(rx*width,ry*width) for z,rx,ry in profile]
 tube('Sculpted continuous torso',pts,rads,fur,segments=32,weight_fn=lambda j,v:{'pelvis':1-min(1,max(0,(v.z-.56)/.33)),'spine':min(1,max(0,(v.z-.56)/.33))})
 if kind=='fox':ellipsoid('Chest bib',(0,-.169,.86),(.183*width,.082,.25),cream,'spine',deform=lambda q:Vector((q.x*(1-.22*q.z),q.y,q.z)))
 # Broad temples, lifted cheekbones, narrowed jaw: each kind has its own sculpted skull.
 hx=.39 if kind!='bear' else .42;hy=.285 if kind!='bear' else .32
 def face(q):
  x,y,z=q;cheek=1+.12*math.exp(-((z+.32)/.28)**2);x*=cheek
  if y<0:y-=.11*math.exp(-((z+.1)/.6)**2)*(1-abs(x))
  return Vector((x,y,z))
 ellipsoid('Sculpted expressive head',(0,-.015,1.43),(hx,hy,.335),fur,'head',40,26,face)
 if kind in ['fox','rabbit']:
  for side in [-1,1]:
   ellipsoid('Cream facial mask',(side*.209,-.214,1.306),(.176,.065,.154),cream,'head',32,22,deform=lambda q:Vector((q.x*(1+.10*q.z),q.y,q.z)))
 # Eye sockets and large layered almond eyes with modeled lids, pupils, glints.
 for side,suf in [(-1,'L'),(1,'R')]:
  eyeBone='eye.'+suf;ex=side*.19;ey=-.265;ez=1.50
  ellipsoid('Eye socket '+suf,(ex,ey+.011,ez),(.125,.033,.119),fur,'head',28,18)
  ellipsoid('Sclera '+suf,(ex,ey-.013,ez),(.109,.037,.109),white,eyeBone,28,20)
  ellipsoid('Iris '+suf,(ex-side*.009,ey-.047,ez+.001),(.088,.016,.096),iris,eyeBone,28,18)
  ellipsoid('Pupil '+suf,(ex-side*.01,ey-.061,ez+.003),(.022 if kind=='cat' else .048,.011,.072),pupil,eyeBone,24,16)
  ellipsoid('Key catchlight '+suf,(ex-.022,ey-.073,ez+.047),(.025,.006,.031),shine,eyeBone,16,12);ellipsoid('Secondary catchlight '+suf,(ex+.027,ey-.071,ez-.032),(.009,.005,.010),shine,eyeBone,12,8)
  lid=[(ex+math.cos(a)*.123,ey-.034-math.sin(a)*.013,ez+math.sin(a)*.112) for a in [j/14*math.pi for j in range(15)]]
  tube('Upper eyelid '+suf,lid,[.008]*15,fur,eyeBone,8)
  brow=[(ex+side*(t-.5)*.22,ey+.001,ez+.158+.025*math.sin(t*math.pi)) for t in [i/8 for i in range(9)]];tube('Expression brow '+suf,brow,[.004+.010*math.sin(i/8*math.pi) for i in range(9)],fur,'head',8)
 # Sculpted muzzle and mouth; cheek tufts replace smooth ball silhouettes.
 mz=1.29;my=-.285 if kind in ['cat','rabbit'] else -.32
 for side in [-1,1]:
  ellipsoid('Muzzle lobe', (side*.065,my-.065,mz),(.103,.105,.072),cream,'head',30,20,deform=lambda q:Vector((q.x,q.y*(1-.18*q.z),q.z)))
 ellipsoid('Smiling mouth',(0,my-.106,1.215),(.083,.030,.052),mouth,'jaw',28,18)
 ellipsoid('Lower lip',(0,my-.095,1.18),(.086,.034,.028),cream,'jaw',28,16)
 ellipsoid('Tongue',(0,my-.136,1.192),(.050,.013,.018),pink,'jaw',20,12)
 for side in [-1,1]:ellipsoid('Small upper tooth',(side*.025,my-.137,1.241),(.019,.011,.015),white,'jaw',14,8)
 noseverts=[(-.058,my-.176,1.306),(.058,my-.176,1.306),(0,my-.191,1.26),(0,my-.154,1.298)]
 obj_mesh('Triangular sculpted nose',noseverts,[(0,1,2),(0,3,1),(0,2,3),(1,3,2)],dark,'head')
 for side in [-1,1]:
  smile=[(side*t*.102,my-.166+.016*t,1.251-.021*math.sin(t*math.pi)) for t in [i/10 for i in range(11)]];tube('Smile crease',smile,[.0045]*11,dark,'head',6)
  for i in range(3):ellipsoid('Whisker follicle',(side*(.09+i*.018),my-.145,1.30-i%2*.02),(.006,.004,.006),dark,'head',10,6)
  for i in range(2 if kind in ['fox','bear'] else 1):
   base=(side*(.30+i*.022),-.17,1.31-i*.042);tip=(side*(.38+i*.024),-.135,1.27-i*.040)
   tube('Cheek fur blade',[base,((base[0]+tip[0])*.5,base[1]-.03,base[2]),tip],[.026,.023,.0018],cream if kind=='fox' else fur,'head',9)
 # Ear silhouettes: large fennec triangles, pointed cat, round bear, long rabbit.
 for side,suf in [(-1,'L'),(1,'R')]:
  if kind=='bear':
   ellipsoid('Round bear ear '+suf,(side*.345,.015,1.735),(.17,.105,.18),fur,'ear.'+suf,26,18);ellipsoid('Bear ear cup '+suf,(side*.35,-.077,1.745),(.102,.027,.111),inner,'ear.'+suf,24,16)
  else:
   h=.70 if kind=='fox' else .47 if kind=='cat' else .91;w=.29 if kind=='fox' else .17 if kind=='cat' else .125
   ear('Sculpted ear '+suf,(side*.24,.01,1.63),h,w,side*(.23 if kind=='fox' else .10),fur,inner,'ear.'+suf,kind)
 # Three swept crown locks give a distinct fur silhouette.
 for i in range(3 if kind=='fox' else 2):
  tube('Crown groom',[(i*.048-.048,-.045,1.72),(i*.052-.04,-.045,1.83+i*.015),(i*.03-.045,.005,1.865+i*.016)],[.048,.026,.0015],fur,'head',10)
 # Continuous arms and legs with smoothly blended elbow/knee skin weights.
 for side,suf in [(-1,'L'),(1,'R')]:
  armpts=[(side*.23,0,1.01),(side*.32,0,.98),(side*.40,0,.87),(side*.415,0,.78),(side*.402,-.02,.65),(side*.40,-.025,.58)]
  def aw(j,v,suf=suf):
   f=min(1,max(0,(.87-v.z)/.15));return{'upper_arm.'+suf:1-f,'forearm.'+suf:f}
  tube('Arm '+suf,armpts,[.104,.103,.094,.078,.072,.071],fur,segments=18,weight_fn=aw)
  ellipsoid('Paw '+suf,(side*.40,-.033,.525),(.095,.092,.107),fur,'hand.'+suf,24,18)
  for j in range(3):ellipsoid('Paw toe '+suf,(side*.40+(j-1)*.043,-.074,.49),(.030,.044,.040),cream if kind=='fox' else fur,'hand.'+suf,14,10)
  legpts=[(side*.15,.015,.56),(side*.163,.014,.47),(side*.17,0,.33),(side*.17,-.015,.24),(side*.17,-.033,.125)]
  def lw(j,v,suf=suf):
   f=min(1,max(0,(.38-v.z)/.14));return{'thigh.'+suf:1-f,'shin.'+suf:f}
  tube('Leg '+suf,legpts,[.13,.121,.093,.080,.078],fur,segments=20,weight_fn=lw)
  ellipsoid('Foot '+suf,(side*.17,-.115,.082),(.124,.205 if kind=='rabbit' else .171,.084),cream if kind in ['fox','rabbit'] else fur,'foot.'+suf,28,18)
  for j in range(3):ellipsoid('Toe pad '+suf,(side*.17+(j-1)*.053,-.25 if kind=='rabbit' else -.223,.072),(.037,.052,.046),cream if kind in ['fox','rabbit'] else fur,'foot.'+suf,14,10)
 # Tail, segmented weight blend; fox tail has a large cream tip and flowing silhouette.
 if kind=='fox':
  tailpts=[(0,.15,.56),(0,.30,.56),(.05,.48,.59),(.12,.69,.72),(.16,.82,.91),(.15,.87,1.02)]
  rad=[.075,.155,.20,.19,.12,.01]
 elif kind=='cat':tailpts=[(0,.13,.56),(.035,.34,.57),(.15,.56,.72),(.24,.65,.95),(.20,.64,1.12),(.08,.60,1.15)];rad=[.06,.062,.063,.055,.045,.015]
 else:tailpts=[(0,.16,.54),(0,.29,.55),(0,.36,.58)];rad=[.06,.115 if kind=='rabbit' else .072,.005]
 def tw(j,v):
  if j<2:return{'tail.0':1}
  if j<4:return{'tail.0':.15,'tail.1':.85}
  return{'tail.1':.2,'tail.2':.8}
 tube('Groomed tail',tailpts,rad,fur,segments=22,weight_fn=tw)
 if kind=='fox':tube('Cream tail brush',tailpts[3:],[.194,.123,.0015],cream,segments=24,weight_fn=lambda j,v:{'tail.1':max(0,1-j*.5),'tail.2':min(1,j*.5)})
 # Tail fur fins are genuine tapered meshes, not a texture around a cylinder.
 for j in range(12 if kind=='fox' else 5):
  k=1+j%(len(tailpts)-2);a=j*2.399;r=rad[k];c=Vector(tailpts[k]);base=c+Vector((math.cos(a)*r,0,math.sin(a)*r));tip=base+Vector((math.cos(a)*.065,.045,math.sin(a)*.065));tube('Tail fur',[tuple(base),tuple((base+tip)*.5+Vector((0,.015,0))),tuple(tip)],[.011,.014,.001],cream if kind=='fox' and k>=3 else fur,'tail.1' if k<3 else 'tail.2',7)
 # Cloth: scarf for fox, tailored sleeveless jackets for the remaining cast.
 collarpts=[(.145*math.cos(i/32*math.tau),.02+.145*math.sin(i/32*math.tau),1.11+.015*math.sin(i/32*math.tau)) for i in range(33)]
 tube('Silk scarf collar',collarpts,[.053]*33,cloth,'neck',12)
 if kind=='fox':
  for side,suf in [(-1,'L'),(1,'R')]:
   ribbon('Flowing silk scarf '+suf,[(side*.065,.12,1.12),(side*.13,.29,1.095),(side*.14,.44,1.01),(side*.12,.61,1.03),(side*.18,.71,1.12)],[.05,.06,.07,.07,.015],cloth,'scarf.'+suf)
 else:
  # Side panels hug the body; curved front opening remains visible over the belly.
  for side,suf in [(-1,'L'),(1,'R')]:
   verts=[];faces=[];uv=[]
   for j in range(10):
    t=j/9;z=.48+t*.59;lower=max(0,next((i-1 for i,q in enumerate(profile) if q[0]>=z),len(profile)-2));pa,pb=profile[lower],profile[lower+1];f=(z-pa[0])/(pb[0]-pa[0]);rx=(pa[1]+(pb[1]-pa[1])*f)*width+.024;ry=(pa[2]+(pb[2]-pa[2])*f)*width+.022
    for k in range(14):
     a=-math.pi/2+side*(.14+k/13*(math.pi-.28));verts.append((math.cos(a)*rx,math.sin(a)*ry-.004,z));uv.append((k/13,t))
   for j in range(9):
    for k in range(13):a=j*14+k;faces.append((a,a+1,a+15,a+14))
   jacket=obj_mesh('Tailored vest '+suf,verts,faces,cloth,'spine');sol=jacket.modifiers.new('Cloth thickness','SOLIDIFY');sol.thickness=.022;bpy.context.view_layer.objects.active=jacket;bpy.ops.object.modifier_apply(modifier=sol.name)
   ribbon('Jacket lapel '+suf,[(side*.06,-.201,.88),(side*.12,-.18,1.01),(side*.12,-.145,1.08)],[.036,.055,.035],cloth,'spine')
   for z in [.62,.76,.90]:ellipsoid('Antique button',(side*.046,-.25*width,z),(.015,.008,.015),gold,'spine',12,8)
  if kind=='rabbit':
   bandpts=[(.385*math.cos(i/36*math.tau),.015+.281*math.sin(i/36*math.tau),1.61+.020*math.sin(i/36*math.tau)) for i in range(37)];tube('Rabbit blue headband',bandpts,[.028]*37,cloth,'head',10)
 # Small tufts at chest/temple preserve an organic outline at mobile size.
 for side in [-1,1]:
  for i in range(0):
   x=side*(.272+.025*math.sin(i*.8));z=.67+i*.084;start=(x,-.06,z);end=(x+side*.047,-.045,z-.025)
   tube('Flank fur',[start,((start[0]+end[0])/2,-.08,z),end],[.012,.009,.0015],fur,'spine' if z>.75 else 'pelvis',7)
 rig=rig_create()
 def proportion(v):
  q=v.copy();q.z=v.z*.83 if v.z<=1.10 else .913+(v.z-1.10)*1.08
  f=1+.09*max(0,min(1,(v.z-1.08)/.20));q.x*=f;q.y*=f;return q
 for obj in PARTS:
  for v in obj.data.vertices:v.co=proportion(v.co)
 bpy.context.view_layer.objects.active=rig;bpy.ops.object.mode_set(mode='EDIT')
 for b in rig.data.edit_bones:b.head=proportion(b.head);b.tail=proportion(b.tail)
 bpy.ops.object.mode_set(mode='OBJECT');bpy.ops.object.select_all(action='DESELECT')
 for o in PARTS:o.select_set(True)
 bpy.context.view_layer.objects.active=PARTS[0];bpy.ops.object.join();skin=bpy.context.object;skin.name=kind.title()+'_SkinnedSurface';skin.parent=rig;mod=skin.modifiers.new('DuneDash skeletal deformation','ARMATURE');mod.object=rig
 # Uniform whole-cast scale keeps gameplay capsules independent from decorative ears/tails.
 rig.scale=(.72,.72,.72);rig['character']=kind;rig['production']='Original modeled mesh, UV albedo, armature and named actions';rig['forward']='Blender -Y; exported GLTF +Z';rig['collision']='Cosmetic only; platform/arena/run/level.mjs remains authoritative'
 return rig,skin

CLIPS={'idle':(96,True),'run':(24,True),'jump':(24,False),'land':(10,False),'slide':(18,False),'hit':(24,False),'fall':(30,False),'recover':(18,False),'finish':(36,False),'celebrate':(60,True)}
def animate_rig(rig):
 rig.animation_data_create();bones=rig.pose.bones
 def reset():
  for b in bones:b.location=(0,0,0);b.rotation_euler=(0,0,0);b.scale=(1,1,1)
 for name,(duration,loop) in CLIPS.items():
  reset();action=bpy.data.actions.new(name);action.use_fake_user=True;rig.animation_data.action=action
  for frame in range(0,duration+1,2):
   t=frame/duration;phase=t*math.tau;reset();pelvis=bones['pelvis'];spine=bones['spine'];head=bones['head'];jaw=bones['jaw']
   speed=math.sin(phase);breath=math.sin(phase)
   if name=='idle':
    spine.scale.y=1+.014*breath;head.rotation_euler[2]=.035*breath;pelvis.location.z=.010*breath
   elif name=='run':
    pelvis.location.z=.033*(1-math.cos(phase*2));pelvis.rotation_euler[1]=.045*speed;spine.rotation_euler[0]=.11;head.rotation_euler[0]=-.065;jaw.rotation_euler[0]=-.10
    for side,suf in [(-1,'L'),(1,'R')]:
     s=math.sin(phase+(0 if side<0 else math.pi));bones['thigh.'+suf].rotation_euler[0]=s*.69;bones['shin.'+suf].rotation_euler[0]=-max(0,-s)*1.15;bones['foot.'+suf].rotation_euler[0]=max(0,s)*.2;bones['upper_arm.'+suf].rotation_euler[0]=-s*.73;bones['forearm.'+suf].rotation_euler[0]=-.50-max(0,s)*.18
   elif name=='jump':
    crouch=math.sin(math.pi*t);spine.rotation_euler[0]=-.12*crouch;head.rotation_euler[0]=-.10;jaw.rotation_euler[0]=-.22
    for side,suf in [(-1,'L'),(1,'R')]:bones['thigh.'+suf].rotation_euler[0]=.50*crouch;bones['shin.'+suf].rotation_euler[0]=-.92*crouch;bones['upper_arm.'+suf].rotation_euler[0]=-.95*crouch;bones['upper_arm.'+suf].rotation_euler[2]=side*.24*crouch
   elif name=='land':
    a=math.sin(math.pi*t);pelvis.location.z=-.12*a;spine.rotation_euler[0]=.22*a
    for suf in ['L','R']:bones['thigh.'+suf].rotation_euler[0]=.5*a;bones['shin.'+suf].rotation_euler[0]=-.75*a;bones['upper_arm.'+suf].rotation_euler[0]=-.30*a
   elif name=='slide':
    a=min(1,t*6,(1-t)*6);pelvis.location.z=-.27*a;pelvis.rotation_euler[0]=-.7*a;spine.rotation_euler[0]=-.30*a
    for suf in ['L','R']:bones['thigh.'+suf].rotation_euler[0]=1.1*a;bones['shin.'+suf].rotation_euler[0]=-.45*a;bones['upper_arm.'+suf].rotation_euler[0]=.7*a
   elif name=='hit':
    a=math.sin(math.pi*t)*(1-t*.45);spine.rotation_euler[0]=-.34*a;head.rotation_euler[1]=.17*math.sin(phase*3)*a;jaw.rotation_euler[0]=-.3*a
    for side,suf in [(-1,'L'),(1,'R')]:bones['upper_arm.'+suf].rotation_euler[2]=side*.65*a;bones['ear.'+suf].rotation_euler[0]=.45*a
   elif name=='fall':
    spine.rotation_euler[0]=-.25;head.rotation_euler[0]=-.25;jaw.rotation_euler[0]=-.37
    for side,suf in [(-1,'L'),(1,'R')]:bones['upper_arm.'+suf].rotation_euler[0]=-.65+.3*math.sin(phase*2+side);bones['upper_arm.'+suf].rotation_euler[2]=side*.95;bones['thigh.'+suf].rotation_euler[0]=side*.38*math.sin(phase*2)
   elif name=='recover':
    a=(1-t)**2;pelvis.location.z=-.16*a;spine.rotation_euler[0]=.42*a;head.rotation_euler[0]=-.16*a
    for suf in ['L','R']:bones['thigh.'+suf].rotation_euler[0]=.60*a;bones['shin.'+suf].rotation_euler[0]=-.85*a
   elif name in ['finish','celebrate']:
    a=min(1,t*4);bounce=math.sin(phase*2);pelvis.location.z=.045*max(0,bounce);head.rotation_euler[1]=.055*math.sin(phase);jaw.rotation_euler[0]=-.25*a
    for side,suf in [(-1,'L'),(1,'R')]:bones['upper_arm.'+suf].rotation_euler[2]=-side*(2.35+.10*bounce)*a;bones['upper_arm.'+suf].rotation_euler[0]=-.20*a;bones['forearm.'+suf].rotation_euler[0]=-.45*a;bones['hand.'+suf].rotation_euler[1]=.2*math.sin(phase*2)*a
   for side,suf in [(-1,'L'),(1,'R')]:
    bones['ear.'+suf].rotation_euler[1]+=.045*math.sin(phase+side);bones['scarf.'+suf].rotation_euler[0]=.10*math.sin(phase*2+side);bones['scarf.'+suf].rotation_euler[1]=.15*math.sin(phase+side)
    blink=(abs(t-.42)<.021 or abs(t-.78)<.019) if duration>=60 else (name=='hit' and .10<t<.28)
    bones['eye.'+suf].scale.y=.065 if blink else 1
   for n in ['tail.0','tail.1','tail.2']:bones[n].rotation_euler[2]=.13*math.sin(phase+.5*int(n[-1]));bones[n].rotation_euler[0]=.06*math.sin(phase*2)
   for b in bones:
    b.keyframe_insert('location',frame=frame);b.keyframe_insert('rotation_euler',frame=frame);b.keyframe_insert('scale',frame=frame)
  rig.animation_data.action=None;track=rig.animation_data.nla_tracks.new();track.name=name;strip=track.strips.new(name,0,action);strip.action_frame_start=0;strip.action_frame_end=duration;strip.blend_type='REPLACE';strip.extrapolation='NOTHING'
 reset();rig.animation_data.action=None

def studio(rig):
 scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=40;scene.render.resolution_x=700;scene.render.resolution_y=800;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.render.film_transparent=True;scene.world.color=(.15,.15,.15)
 scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast'
 def area(name,loc,power,size,col):
  data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size;data.color=col;o=bpy.data.objects.new(name,data);scene.collection.objects.link(o);o.location=loc;o.rotation_euler=(Vector((0,0,.9))-o.location).to_track_quat('-Z','Y').to_euler()
 area('Warm key',(-3,-4,5),350,4,(1,.82,.61));area('Soft face fill',(3,-3,2.4),180,3,(.72,.87,1));area('Fur rim',(1.5,3,4),500,3,(1,.80,.54))
 camd=bpy.data.cameras.new('Character portrait camera');cam=bpy.data.objects.new('Character portrait camera',camd);scene.collection.objects.link(cam);cam.location=(2.5,-5.5,2.1);cam.rotation_euler=(Vector((0,0,.92))-cam.location).to_track_quat('-Z','Y').to_euler();camd.type='ORTHO';camd.ortho_scale=2.05;scene.camera=cam
 return cam

def output(kind,rig,skin):
 animate_rig(rig);bpy.context.scene.render.fps=30;bpy.context.scene.frame_start=0;bpy.context.scene.frame_end=96
 bpy.ops.object.select_all(action='DESELECT');skin.select_set(True);rig.select_set(True);bpy.context.view_layer.objects.active=rig
 dest=OUT/(kind+'.glb');bpy.ops.export_scene.gltf(filepath=str(dest),export_format='GLB',use_selection=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_skins=True,export_morph=True,export_yup=True,export_apply=False)
 for track in rig.animation_data.nla_tracks:track.mute=True
 rig.animation_data.action=None
 for b in rig.pose.bones:b.location=(0,0,0);b.rotation_euler=(0,0,0);b.scale=(1,1,1)
 bpy.context.scene.frame_set(0);studio(rig)
 bpy.ops.wm.save_as_mainfile(filepath=str(OUT/(kind+'.blend')))
 bpy.context.scene.render.filepath=str(OUT/(kind+'-portrait.png'));bpy.ops.render.render(write_still=True)
 meta={'character':kind,'blend':kind+'.blend','glb':kind+'.glb','bones':len(rig.data.bones),'vertices':len(skin.data.vertices),'triangles':sum(len(f.vertices)-2 for f in skin.data.polygons),'clips':{name:{'duration_s':frames/30,'loop':loop} for name,(frames,loop) in CLIPS.items()},'materials':len(skin.data.materials),'source':'Original deterministic Blender authoring script; not downloaded characters','forward':'GLTF +Z, feet at origin; runtime rotates Y by pi to race toward -Z'}
 (OUT/(kind+'-manifest.json')).write_text(json.dumps(meta,indent=2)+'\n');print('CHARACTER_DONE',json.dumps(meta))

for kind in ([args.only] if args.only else list(PALETTES)):
 rig,skin=make_character(kind);output(kind,rig,skin)
