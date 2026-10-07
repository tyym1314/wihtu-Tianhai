/** Build every player entry before recording the packaging freshness gate. */
import {spawnSync} from 'node:child_process';
import {rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {verifyPublishedAndroidArtifact} from './android-artifact.mjs';
const cwd=fileURLToPath(new URL('..',import.meta.url));
// A failed rebuild must never leave an apparently valid previous stamp.
rmSync(new URL('../release-build-manifest.json',import.meta.url),{force:true});
const artifact=await verifyPublishedAndroidArtifact(cwd);
console.log(`Preserving reviewed ${artifact.variant} APK ${artifact.version}: ${artifact.sha256}`);
for(const script of ['check:contracts','build:legacy','build:partner-kit','build:arena','build']){
  const child=spawnSync('npm',['run',script],{cwd,stdio:'inherit'});
  if(child.error)throw child.error;
  if(child.status!==0)process.exit(child.status||1);
}
await verifyPublishedAndroidArtifact(cwd);
const child=spawnSync('python3',['deploy/release_build.py','record'],{cwd,stdio:'inherit'});
if(child.error)throw child.error;
process.exitCode=child.status??1;
