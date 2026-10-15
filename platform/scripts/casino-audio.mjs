// Build casino audio (CC0 sources in .local/audio) into casino/public/audio/*.mp3 with ffmpeg.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
const root=new URL('..',import.meta.url).pathname,src=root+'.local/audio/',out=root+'casino/public/audio/';mkdirSync(out,{recursive:true});
const K=(pack,file)=>`kenney/${pack}/${file}`;
const find=(pack,name)=>execFileSync('find',[src+'kenney/'+pack,'-name',name]).toString().trim().split('\n')[0].slice(src.length);
const MUSIC={
 greedylion:['music/banana-track--banana_track.ogg','Banana Track by skrjablin (OpenGameArt, CC0)'],
 rocketstar2:['music/space-city--space_city_bpm115_0.ogg','Space City (OpenGameArt, CC0)'],
 teenpatti:['music/sitarian--sitarian_0.mp3','Sitarian (OpenGameArt, CC0)'],
 olympus:['music/experimenting-with-greek-instrument-samples--greek%20instruments_0.ogg','Greek instruments by Spring Spring (OpenGameArt, CC0)'],
};
const SFX={
 click:find('interface-sounds','click_002.ogg'),select:find('interface-sounds','select_002.ogg'),error:find('interface-sounds','error_004.ogg'),
 open:find('interface-sounds','open_002.ogg'),close:find('interface-sounds','close_002.ogg'),tick:find('interface-sounds','tick_002.ogg'),
 chip:find('casino-audio','chip-lay-2.ogg'),chips:find('casino-audio','chips-collide-3.ogg'),stack:find('casino-audio','chips-stack-4.ogg'),
 card:find('casino-audio','card-place-2.ogg'),deal:find('casino-audio','card-slide-3.ogg'),flip:find('casino-audio','card-shove-2.ogg'),shuffle:find('casino-audio','card-shuffle.ogg'),
 win:find('music-jingles','jingles_PIZZI04.ogg'),bigwin:find('music-jingles','jingles_SAX05.ogg'),lose:find('music-jingles','jingles_PIZZI10.ogg'),feature:find('music-jingles','jingles_SAX10.ogg'),
 coin:find('digital-audio','powerUp2.ogg'),tumble:find('impact-sounds','impactGlass_light_002.ogg'),drop:find('interface-sounds','drop_002.ogg'),
 spin:find('interface-sounds','maximize_006.ogg'),orb:find('digital-audio','phaserUp4.ogg'),thunder:find('sci-fi-sounds','lowFrequency_explosion_000.ogg'),
 engine:find('sci-fi-sounds','spaceEngineLow_001.ogg'),launch:find('sci-fi-sounds','thrusterFire_002.ogg'),boom:find('sci-fi-sounds','explosionCrunch_002.ogg'),cash:find('digital-audio','threeTone2.ogg'),
};
const run=(i,o,args)=>execFileSync('ffmpeg',['-loglevel','error','-y','-i',src+i,...args,out+o]);
for(const [g,[f]] of Object.entries(MUSIC))run(f,`music-${g}.mp3`,['-t','95','-af','afade=t=out:st=92:d=3','-ac','2','-ar','44100','-b:a','80k']);
for(const [n,f] of Object.entries(SFX))run(f,`sfx-${n}.mp3`,['-ac','1','-ar','44100','-b:a','64k']);
writeFileSync(out+'LICENSES.md',['# Casino audio sources','','All files are CC0 1.0 (public domain).','',...Object.entries(MUSIC).map(([g,[,c]])=>`- music-${g}.mp3: ${c}`),'- sfx-*.mp3: Kenney audio packs (kenney.nl: Casino Audio, Interface Sounds, Impact Sounds, Digital Audio, Music Jingles, Sci-fi Sounds), CC0',''].join('\n'));
console.log(Object.keys(SFX).length,'sfx',Object.keys(MUSIC).length,'music');
