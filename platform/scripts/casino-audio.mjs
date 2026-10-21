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
 greedycat2:['music/banana-track--banana_track.ogg','Banana Track by skrjablin (OpenGameArt, CC0)'],
 greedyking:['music/medieval-kings-feast--Kings_Feast.mp3',"Medieval: King's Feast by RandomMind (OpenGameArt, CC0)"],
 greedyforest:['music/joyful-jungle--joyful_jungle_bpm140.ogg','Joyful Jungle by MintoDog (OpenGameArt, CC0)'],
 herochest:['music/bravery-run--bravery_run_bpm170.ogg','Bravery Run by MintoDog (OpenGameArt, CC0)'],
 crazyfruit:['music/amusement-park-stage--amusement_park_stage_bpm150.ogg','Amusement park Stage by MintoDog (OpenGameArt, CC0)'],
 footballleague:['music/fever-stadium--fever_stadium_bpm165.ogg','Fever Stadium by MintoDog (OpenGameArt, CC0)'],
 glorycup:['music/fever-stadium--fever_stadium_bpm165.ogg','Fever Stadium by MintoDog (OpenGameArt, CC0)'],
 magiccard:['music/experimenting-with-greek-instrument-samples--greek%20instruments_0.ogg','Greek instruments by Spring Spring (OpenGameArt, CC0)'],
 solomonmines:['music/bravery-run--bravery_run_bpm170.ogg','Bravery Run by MintoDog (OpenGameArt, CC0)'],
 roulette:['music/medieval-kings-feast--Kings_Feast.mp3',"Medieval: King's Feast by RandomMind (OpenGameArt, CC0)"],
 roulettepro:['music/space-city--space_city_bpm115_0.ogg','Space City (OpenGameArt, CC0)'],
 sicbo:['music/sitarian--sitarian_0.mp3','Sitarian (OpenGameArt, CC0)'],
 crash:['music/happy-clappy-loop--HappyClappyLoop.mp3','Happy Clappy Loop (OpenGameArt, CC0)'],
 crashstar:['music/space-adventure--space_adventure_bpm140.mp3','Space Adventure (OpenGameArt, CC0)'],
 monster:['music/experimenting-with-greek-instrument-samples--greek%20boss%20battle_0.ogg','Greek boss battle by Spring Spring (OpenGameArt, CC0)'],
 molestar:['music/amusement-park-stage--amusement_park_stage_bpm150.ogg','Amusement park Stage by MintoDog (OpenGameArt, CC0)'],
 oceanslot:['music2/binary-underwater-village-loop--binary_village_0.mp3','Binary Underwater Village (OpenGameArt, CC0)'],
 mahjongslot:['music/electronic-indian-tabla-tune--foe%20test%20mix.mp3','Electronic Indian tabla tune (OpenGameArt, CC0)'],
 cleopatraslot:['music/experimenting-with-greek-instrument-samples--greek%20instruments_0.ogg','Greek instruments by Spring Spring (OpenGameArt, CC0)'],
 crazygems:['music2/diamond-race--diamond_race.mp3','Diamond Race (OpenGameArt, CC0)'],
 slot777:['music2/bossa-nova--8bit%20Bossa.mp3','8bit Bossa (OpenGameArt, CC0)'],
 djlive:['music2/bouncer-0--Of%20Far%20Different%20Nature%20-%20Bouncer%20%28CC0%29.wav','Bouncer by Of Far Different Nature (OpenGameArt, CC0)'],
 jackpotslots:['music2/8-bit-victory-loop--8bitvictory_0.ogg','8-bit Victory Loop (OpenGameArt, CC0)'],
 yummy:['music2/candy-day--candy_day_2.mp3','Candy Day (OpenGameArt, CC0)'],
 worldgoal:['music2/beach-sports-theme-loop--ogg_beachtheme_3.ogg','Beach Sports Theme Loop (OpenGameArt, CC0)'],
 chillislot:['music2/funked-up--Funked%20Up.mp3','Funked Up (OpenGameArt, CC0)'],
 sphinxlegend:['music/experimenting-with-greek-instrument-samples--greek%20boss%20battle_0.ogg','Greek boss battle by Spring Spring (OpenGameArt, CC0)'],
 nights1001:['music2/hyyoshi-arabian-syle-backgound-music-rpg--Hyoshi2.ogg','Arabian style background music by Hyyoshi (OpenGameArt, CC0)'],
 pyramidslots:['music2/desert-loop-lo-fi-remaster--desert_loops_2.wav','Desert Loop lo-fi remaster (OpenGameArt, CC0)'],
 magicslot:['music/medieval-kings-feast--Kings_Feast.mp3',"Medieval: King's Feast by RandomMind (OpenGameArt, CC0)"],
 bountyfootball:['music/space-adventure--space_adventure_bpm140.mp3','Space Adventure (OpenGameArt, CC0)'],
 bigeater:['music/banana-track--banana_track.ogg','Banana Track by skrjablin (OpenGameArt, CC0)'],
 greedybrutal:['music/experimenting-with-greek-instrument-samples--greek%20boss%20battle_0.ogg','Greek boss battle by Spring Spring (OpenGameArt, CC0)'],
 fruitparty:['music/happy-clappy-loop--HappyClappyLoop.mp3','Happy Clappy Loop (OpenGameArt, CC0)'],
};
const SFX={
 click:find('interface-sounds','click_002.ogg'),select:find('interface-sounds','select_002.ogg'),error:find('interface-sounds','error_004.ogg'),
 open:find('interface-sounds','open_002.ogg'),close:find('interface-sounds','close_002.ogg'),tick:find('interface-sounds','tick_002.ogg'),
 dice:find('casino-audio','dice-shake-1.ogg'),throw:find('casino-audio','dice-throw-1.ogg'), shoot:find('sci-fi-sounds','laserSmall_000.ogg'),zap:find('digital-audio','zap1.ogg'),hit:find('impact-sounds','impactPunch_medium_001.ogg'),whack:find('impact-sounds','impactWood_heavy_002.ogg'),bomb:find('sci-fi-sounds','explosionCrunch_002.ogg'), stop:find('interface-sounds','drop_001.ogg'), chip:find('casino-audio','chip-lay-2.ogg'),chips:find('casino-audio','chips-collide-3.ogg'),stack:find('casino-audio','chips-stack-4.ogg'),
 card:find('casino-audio','card-place-2.ogg'),deal:find('casino-audio','card-slide-3.ogg'),flip:find('casino-audio','card-shove-2.ogg'),shuffle:find('casino-audio','card-shuffle.ogg'),
 win:find('music-jingles','jingles_PIZZI04.ogg'),bigwin:find('music-jingles','jingles_SAX05.ogg'),lose:find('music-jingles','jingles_PIZZI10.ogg'),feature:find('music-jingles','jingles_SAX10.ogg'),
 coin:find('digital-audio','powerUp2.ogg'),tumble:find('impact-sounds','impactGlass_light_002.ogg'),drop:find('interface-sounds','drop_002.ogg'),
 spin:find('interface-sounds','maximize_006.ogg'),orb:find('digital-audio','phaserUp4.ogg'),thunder:find('sci-fi-sounds','lowFrequency_explosion_000.ogg'),
 engine:find('sci-fi-sounds','spaceEngineLow_001.ogg'),launch:find('sci-fi-sounds','thrusterFire_002.ogg'),boom:find('sci-fi-sounds','explosionCrunch_002.ogg'),cash:find('digital-audio','threeTone2.ogg'),
};
const run=(i,o,args)=>execFileSync('ffmpeg',['-loglevel','error','-y','-i',src+i,...args,out+o]);
for(const [g,[f]] of Object.entries(MUSIC))run(f,`music-${g}.mp3`,['-t','95','-af','afade=t=out:st=92:d=3','-ac','2','-ar','44100','-b:a','80k']);
for(const [n,f] of Object.entries(SFX))run(f,`sfx-${n}.mp3`,['-ac','1','-ar','44100','-b:a','64k']);
writeFileSync(out+'LICENSES.md',['# Casino audio sources','','All files are CC0 1.0 (public domain).','',...Object.entries(MUSIC).map(([g,[,c]])=>`- music-${g}.mp3: ${c}`),'- sfx-*.mp3: Kenney audio packs (kenney.nl: Casino Audio, Interface Sounds, Impact Sounds, Digital Audio, Music Jingles, Sci-fi Sounds), CC0','','','## Win / reel sound pack (2026-10-20)','','`sfx-reel-loop`, `sfx-reel-stop`, `sfx-anticip`, `sfx-win-s|m|l`, `sfx-rollup`, `sfx-roll-end`, `sfx-sting-great|big|mega|epic`, `sfx-fs-trigger`, `sfx-pop`, `sfx-whoosh`: synthesized in `.local/audio/fx/build.py`, layered with Kenney (CC0) Impact Sounds, Sci-Fi Sounds, Casino Audio and Music Jingles.'].join('\n'));
console.log(Object.keys(SFX).length,'sfx',Object.keys(MUSIC).length,'music');
