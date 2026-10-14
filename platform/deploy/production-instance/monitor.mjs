/** Real production probes. The staged public-origin mismatch is intentionally visible. */
import {monitorConfig,createProbes,runMonitor,atomicReport} from '../monitor.mjs';
import {lstat} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
export function productionMonitorConfig(env=process.env){
 const config=monitorConfig(env);
 if(!config.production||config.apiPort!==18891||config.backupDir!=='/opt/oasis/production-backups'||config.reportFile!=='/opt/oasis/production-instance-private/monitor/status.json'||!['/opt/oasis/acme/config/live/oasis-production-player/fullchain.pem','/opt/oasis/acme/config/live/oasis-game/fullchain.pem'].includes(config.certFile)||env.OASIS_PRODUCTION_CERTIFICATE_UNIT!=='oasis-production-player-certificate.service'||env.OASIS_PRODUCTION_CERTIFICATE_TIMER!=='oasis-production-player-certificate.timer')throw Error('PRODUCTION_MONITOR_SCOPE_INVALID');
 config.serviceUnits=config.serviceUnits.map(unit=>unit==='oasis-production.service'?'oasis-production-api.service':unit);
 config.serviceUnits=config.serviceUnits.map(unit=>unit==='oasis-certificate.service'?env.OASIS_PRODUCTION_CERTIFICATE_UNIT:unit==='oasis-certificate.timer'?env.OASIS_PRODUCTION_CERTIFICATE_TIMER:unit);
 config.jobUnits=config.jobUnits.map(unit=>unit==='oasis-certificate.service'?env.OASIS_PRODUCTION_CERTIFICATE_UNIT:unit);
 return config;
}
export async function monitor(env=process.env){
 const config=productionMonitorConfig(env),parent=path.dirname(config.reportFile),s=await lstat(parent);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o777)!==0o750)throw Error('PRODUCTION_MONITOR_DIRECTORY_UNSAFE');
 // Existing monitor's groupRead uses process GID; run this helper with the dedicated Group.
 return runMonitor(config,{probes:createProbes(config),writeReport:report=>atomicReport(config.reportFile,report,{groupRead:true})});
}
if(process.argv[1]&&pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href===import.meta.url){
 try{const result=await monitor();process.stdout.write(JSON.stringify({environment:'production',status:result.report.status,ingress_pending:result.report.checks.some(c=>c.name==='ingress'&&c.status!=='ok')})+'\n');}
 catch(error){process.stderr.write((/^[A-Z0-9_]+$/.test(error.message)?error.message:'PRODUCTION_MONITOR_FAILED')+'\n');process.exitCode=2;}
}
