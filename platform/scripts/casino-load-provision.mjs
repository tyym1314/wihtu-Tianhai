// Sandbox only: give N load-test players reference-wallet balances in the local sandbox App.
import {pool} from '../server/db.mjs';
import {unseal} from '../server/security.mjs';
import {scope} from '../server/platform.mjs';
import {provisionWallet} from '../server/wallet/index.mjs';
const n=Number(process.argv[2]||300);
const app=(await pool.query("SELECT * FROM gp_apps WHERE environment='sandbox' AND status='active' ORDER BY created_at LIMIT 1")).rows[0];
const key=(await pool.query("SELECT * FROM gp_keys WHERE app_id=$1 AND direction='platform-to-wallet' AND active LIMIT 1",[app.id])).rows[0];
await provisionWallet(pool,{scope:scope(app),key_id:key.id,secret_base64:unseal(key.secret_enc),users:Array.from({length:n},(_,i)=>({external_user_id:`lt_${i}`,balance_minor:'100000000'})),treasury_minor:'100000000000000'});
console.log('provisioned',n,'players in',app.id);await pool.end();
