import {copyFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
mkdirSync(root+'public/previews',{recursive:true});
for(const game of ['match','golf','carrom','darts','ludo','jackaroo','domino','pool','bowling','run']){
 const phase=['match','golf'].includes(game)?'phase-c':['pool','bowling','run'].includes(game)?'phase-e':'phase-d';
 copyFileSync(`${root}review/${phase}/${game}-active-390.png`,`${root}public/previews/${game}.png`);
 copyFileSync(`${root}review/${phase}/videos/${game}-motion.webm`,`${root}public/previews/${game}.webm`);
}
console.log('Published ten reviewed local screenshots and motion clips; no reports or credentials copied.');
