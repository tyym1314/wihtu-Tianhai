/** Public capabilities come from the current reviewed policy, never a report count. */
import {runtime} from './runtime-mode.mjs';
import {publicAdmissionCapability} from './production-admission.mjs';

export async function publicAdmissionStatus(){
 if(runtime.production&&runtime.partnerAdmission)return{...publicAdmissionCapability(null),admission_profile:'partner-external-v1',partner_admission_enabled:true};
 return publicAdmissionCapability(null);
}
