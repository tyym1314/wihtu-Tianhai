/** Build every player entry before recording the packaging freshness gate. */
import {spawnSync} from 'node:child_process';
import {rmSync,readFileSync,copyFileSync,chmodSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('..',import.meta.url));
// A failed rebuild must never leave an apparently valid previous stamp.
rmSync(new URL('../release-build-manifest.json',import.meta.url),{force:true});
for(const script of ['check:contracts','build:android','build:legacy','build:partner-kit','build:arena','build']){
  const child=spawnSync('npm',['run',script],{cwd,stdio:'inherit'});
  if(child.error)throw child.error;
  if(child.status!==0)process.exit(child.status||1);
  if(script==='build:android'){
    const meta=JSON.parse(readFileSync(new URL('../android-smoke/dist/build-checks.json',import.meta.url)));
    if(!/^oasis-android-smoke-[0-9.]+-debug\.apk$/.test(meta.apk))throw Error('Invalid APK artifact');
    const source=new URL('../android-smoke/dist/'+meta.apk,import.meta.url);
    if(createHash('sha256').update(readFileSync(source)).digest('hex')!==meta.apkSha256)throw Error('APK hash differs from build evidence');
    const destination=new URL('../public/downloads/'+meta.apk,import.meta.url);
    copyFileSync(source,destination);chmodSync(destination,0o644);
    writeFileSync(new URL('../public/downloads/android-smoke-build.json',import.meta.url),JSON.stringify({version:meta.version,version_code:meta.versionCode,apk:meta.apk,sha256:meta.apkSha256,game_count:meta.catalog.length,device_verification:'not_performed_by_build'},null,2)+'\n');
  }
}
const child=spawnSync('python3',['deploy/release_build.py','record'],{cwd,stdio:'inherit'});
if(child.error)throw child.error;
process.exitCode=child.status??1;
