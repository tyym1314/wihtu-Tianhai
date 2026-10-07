import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const load=async name=>readFile(new URL('../specs/'+name,import.meta.url),'utf8');

test('published integration contract cannot present partner HMAC as a production player launch',async()=>{
 const spec=JSON.parse(await load('openapi.json'));
 const signed=spec.paths['/v1/sessions'].post;
 assert.equal(signed['x-production-policy'],'platform-player-bff-only');
 assert.match(signed.description,/production.*403 PLAYER_BFF_REQUIRED/i);
 assert.match(signed.description,/same-origin \/api\/player\/launch/i);
 assert(signed.security.some(item=>Object.hasOwn(item,'HmacSignature')),'sandbox HMAC integration remains documented');
 assert(spec.components.schemas.CreateSessionRequest.required.includes('external_user_id'),'sandbox wire contract remains compatible');
 assert.match(spec.components.schemas.CreateSessionRequest.description,/Sandbox partner HMAC request only/);
 const [handoff,bff]=await Promise.all([load('production-handoff.md'),load('player-bff.md')]);
 assert.match(handoff,/正式托管登录\/注册页面已实现/);
 assert.match(handoff,/\/player\?app_id=/);
 assert.match(bff,/合作方外部跳转\/回跳协议.*账号验证\/密码找回仍是单独的上线缺口/);
 assert.match(bff,/不跳往试玩或 mock/);
 assert.match(bff,/查无用户、响应无效、超时和网络错误都阻断新游戏会话/);
});
