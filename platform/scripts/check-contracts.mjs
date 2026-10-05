import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac } from 'node:crypto';
import { games as displayGames } from '../src/data.js';
import { RELEASED_IDS, ARENA_IDS, LEGACY_IDS } from '../shared/games.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'specs', name), 'utf8'));
const spec = read('openapi.json');
const catalog = read('game-catalog.json');
const vector = read('examples/signature-vector.json');
assert.match(spec.openapi, /^3\.1\./);
let refs = 0;
function walk(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) {
    assert.ok(value.$ref.startsWith('#/'), `Unexpected external reference ${value.$ref}`);
    let found = spec;
    for (const part of value.$ref.slice(2).split('/')) found = found?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    assert.notEqual(found, undefined, `Broken reference ${value.$ref}`); refs++;
  }
  for (const item of Object.values(value)) walk(item);
}
walk(spec);
const sorted = values => [...values].sort();
assert.deepEqual(sorted(spec.components.schemas.GameId.enum), sorted(RELEASED_IDS), 'OpenAPI GameId must cover the runtime catalogue');
assert.deepEqual(sorted(spec.components.schemas.CompetitiveGameId.enum), sorted(ARENA_IDS));
assert.deepEqual(sorted(spec.components.schemas.ProbabilityGameId.enum), sorted(LEGACY_IDS));
for (const name of ['ExchangeLaunchRequest', 'ExchangeLaunchResponse']) {
  assert.equal(spec.components.schemas[name].properties.game_id.$ref, '#/components/schemas/GameId', `${name} must share the game identity contract`);
}
assert.equal(catalog.games.length, RELEASED_IDS.length);
assert.equal(new Set(catalog.games.map(g => g.id)).size, RELEASED_IDS.length);
assert.deepEqual(sorted(catalog.games.map(g => g.id)), sorted(RELEASED_IDS));
assert.deepEqual(catalog.games.map(g => g.id).sort(), displayGames.map(g => g.id).sort());
assert.equal(catalog.games.filter(g => g.category === 'competitive').length, ARENA_IDS.length);
assert.equal(catalog.games.filter(g => g.category === 'probability').length, LEGACY_IDS.length);
for (const game of catalog.games) {
  assert.ok(game.players.length > 0);
  if (game.category === 'competitive') {
    assert.equal(typeof game.conceptPath, 'string');
    assert.ok(fs.existsSync(path.resolve(root, '..', game.conceptPath)), `Missing concept ${game.id}`);
  } else {
    for (const field of ['referencePath', 'mathSourcePath']) assert.ok(fs.existsSync(path.resolve(root, '..', game[field])), `Missing source ${game.id}/${field}`);
  }
  assert.equal(displayGames.find(g => g.id === game.id).category, game.category);
}
const digest = createHash('sha256').update(vector.raw_body_utf8, 'utf8').digest('hex');
assert.equal(digest, vector.body_sha256_hex);
assert.equal(Buffer.byteLength(vector.raw_body_utf8), vector.raw_body_byte_length);
const canonical = ['GP-HMAC-SHA256-V1', vector.direction, vector.key_id, vector.timestamp, vector.nonce, vector.request_id, vector.method, vector.canonical_target, digest].join('\n');
assert.equal(canonical, vector.canonical_string_utf8);
assert.equal(Buffer.byteLength(canonical), vector.canonical_string_byte_length);
const secret = Buffer.from(vector.test_secret_base64, 'base64');
assert.equal(secret.toString('utf8'), vector.test_secret_utf8);
const signature = createHmac('sha256', secret).update(canonical).digest('hex');
assert.equal(signature, vector.signature_hex);
assert.equal(`v1=${signature}`, vector.headers['X-GP-Signature']);
assert.notEqual(createHmac('sha256', secret).update(canonical + ' ').digest('hex'), signature);
for (const [count, entry, bps] of [[2n,10000n,500n],[3n,5000n,300n],[4n,10000n,500n],[4n,1n,500n]]) {
  const pool = count * entry; const fee = pool * bps / 10000n; const prize = pool - fee;
  assert.equal(fee + prize, pool);
  const share = prize / count; const remainder = prize % count;
  assert.equal(share * count + remainder, prize);
}
const summary = { checkedAt: new Date().toISOString(), result: 'PASS', scope: 'Static design contracts and reproducible signature only. No wallet/backend/device integration.', paths: Object.keys(spec.paths).length, schemas: Object.keys(spec.components.schemas).length, localRefs: refs, games: catalog.games.length, hmac: 'PASS', integerExamples: 'PASS' };
fs.mkdirSync(path.join(root, 'review'), {recursive:true});
fs.writeFileSync(path.join(root, 'review/contract-check.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
