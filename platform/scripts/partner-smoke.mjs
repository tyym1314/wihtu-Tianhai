import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {OasisClient} from '../specs/examples/sdk-node.mjs';
const file=process.argv[2]||'.local/sandbox-app-credentials.json';
const saved=JSON.parse(readFileSync(resolve(file),'utf8')),item=Array.isArray(saved)?saved[Number(process.argv[3]||0)]:saved;
const {app,credentials}=item;
const client=new OasisClient({baseUrl:process.env.OASIS_API_URL||'http://127.0.0.1:8797',keyId:credentials.key_id,secretBase64:credentials.secret_base64,scope:{partner_id:app.partner_id,app_id:app.id,environment:'sandbox',wallet_scope_id:app.wallet_scope_id,currency_id:app.currency_id}});
const catalog=await client.games();
const session=await client.createSession({requestId:'smoke_'+randomUUID(),externalUserId:'demo_player',gameId:'tiger'});
// Do not print the launch code or API secret into terminal/log history.
console.log(JSON.stringify({app_id:app.id,authorized_games:catalog.games.map(g=>({id:g.game_id,available:g.available})),session_id:session.session_id,entry_url:session.entry_url,expires_in:session.expires_in,launch_code_received:session.launch_code.length>=32},null,2));
