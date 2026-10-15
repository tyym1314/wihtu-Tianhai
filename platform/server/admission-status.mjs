/** Public capabilities come from the current reviewed policy, never a report count. */
import {pool} from './db.mjs';
import {runtime} from './runtime-mode.mjs';
import {readProductionAdmission,publicAdmissionCapability,firstpartyProfile} from './production-admission.mjs';

export async function publicAdmissionStatus(db=pool){
 if(runtime.production&&runtime.partnerAdmission&&!firstpartyProfile(runtime.admissionProfile))return{...publicAdmissionCapability(null),admission_profile:'partner-external-v1',partner_admission_enabled:true};
 if(!runtime.production||!firstpartyProfile(runtime.admissionProfile))return publicAdmissionCapability(null);
 const app=(await db.query('SELECT * FROM gp_apps WHERE id=$1',[runtime.firstpartyAppId])).rows[0];
 if(!app)return publicAdmissionCapability(null);
 try{return publicAdmissionCapability(await readProductionAdmission(db,app,{intent:'metadata'}));}
 catch(error){if(error?.status!==409)throw error;return publicAdmissionCapability(null);}
}
