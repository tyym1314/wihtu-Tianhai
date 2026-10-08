// Explicit release-fixture command: node --test tests/mock-view-assets.mjs.
// The frozen source/views are external evidence, not default-checkout fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer, request} from 'node:http';
import {resolve, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const platform = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(process.env.OASIS_MOCK_VIEW_FIXTURE_ROOT || join(platform, 'review/mock-release-views-20261008'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {
  old: '47e5cab2ff8c910e7821e6c1edbd92a26135944241fc5b0c1610a44952d883bc',
  next: '6b4f3548a8382083d18ded796c9aec7ee09d5a82fcf1020267d3dc2b309db25f',
};
const sourceRoot = {old: join(root, 'sources/mock04'), next: join(root, 'sources/public15')};
const viewRoot = {forward: join(root, 'views/forward'), rollback: join(root, 'views/rollback')};
const json = async path => JSON.parse(await readFile(path, 'utf8'));

async function filesBelow(folder, prefix = '') {
  const files = [];
  for (const name of await readdir(folder)) {
    const relative = prefix + name, path = join(folder, name), info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, relative);
    if (info.isDirectory()) files.push(...await filesBelow(path, relative + '/'));
    else { assert.equal(info.isFile(), true, relative); assert.equal(info.nlink, 1, relative); files.push(relative); }
  }
  return files.sort();
}

async function verifyTree(folder, expectedSourceHash) {
  const raw = await readFile(join(folder, 'RELEASE-MANIFEST.json'));
  if (expectedSourceHash) assert.equal(hash(raw), expectedSourceHash);
  const manifest = JSON.parse(raw);
  if (!expectedSourceHash) assert.deepEqual(await filesBelow(folder), [...Object.keys(manifest), 'RELEASE-MANIFEST.json'].sort());
  for (const [path, expected] of Object.entries(manifest)) {
    assert.match(path, /^[A-Za-z0-9_./@+-]+$/); assert.ok(path.split('/').every(p => p && p !== '.' && p !== '..'));
    const file = join(folder, path), info = await lstat(file);
    assert.equal(info.isFile(), true); assert.equal(info.isSymbolicLink(), false); assert.equal(hash(await readFile(file)), expected, path);
  }
  return manifest;
}

function gameUrl(path) {
  if (path.startsWith('platform/arena/dist/')) return '/arena/' + path.slice('platform/arena/dist/'.length);
  if (path.startsWith('platform/legacy/dist/')) return '/legacy/' + path.slice('platform/legacy/dist/'.length);
  return null;
}

test('derived Mock views preserve actual game-asset HTTP bytes through forward and rollback', async t => {
  const old = await verifyTree(sourceRoot.old, sourceHashes.old);
  const next = await verifyTree(sourceRoot.next, sourceHashes.next);
  const forward = await verifyTree(viewRoot.forward), rollback = await verifyTree(viewRoot.rollback);
  for (const path of ['platform/server/game-assets.mjs', 'platform/shared/games.mjs']) {
    assert.equal(forward[path], next[path], path); assert.equal(rollback[path], old[path], path);
  }
  const inventory = await json(join(root, 'old-installed-inventory.json'));
  assert.equal(inventory.manifest_sha256, sourceHashes.old);
  const missing = Object.keys(next).filter(path => gameUrl(path) && !path.endsWith('.html') && !inventory.files[path]);
  assert.equal(missing.length, 86, '89 new resources: 86 API-served, 3 Nginx platform assets');
  const publicMissing = Object.keys(next).filter(path => path.startsWith('platform/dist/') && !path.endsWith('.html') && !inventory.files[path]);
  assert.equal(publicMissing.length, 3);
  for (const path of [...missing, ...publicMissing]) {
    assert.equal(forward[path], next[path], path); assert.equal(rollback[path], next[path], path);
  }
  for (const path of Object.keys(old).filter(p => gameUrl(p) && !p.endsWith('.html'))) {
    assert.equal(forward[path], old[path], path); assert.equal(rollback[path], old[path], path);
  }

  const modules = {};
  for (const name of ['forward', 'rollback']) {
    modules[name] = await import(pathToFileURL(join(viewRoot[name], 'platform/server/game-assets.mjs')).href);
  }
  let mode = 'rollback';
  const server = createServer((req, res) => {
    const selected = mode;
    modules[selected].serveGameAsset(req, res, req.url, {
      arenaRoot: join(viewRoot[selected], 'platform/arena/dist'), legacyRoot: join(viewRoot[selected], 'platform/legacy/dist'),
    }).catch(error => {
      if (res.headersSent) return res.destroy();
      res.writeHead(error.status || 500); res.end(JSON.stringify({code: error.code}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let requests = 0;
  const send = (path, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    requests++;
    const req = request({hostname: '127.0.0.1', port: server.address().port, path, method, headers, agent: false}, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject); req.end();
  });
  const etags = new Map();
  for (const selected of ['rollback', 'forward', 'rollback']) {
    mode = selected;
    for (const path of missing) {
      const url = gameUrl(path), result = await send(url);
      assert.equal(result.status, 200, url); assert.equal(hash(result.body), next[path], url);
      assert.equal(result.headers['cache-control'], 'public,max-age=31536000,immutable', url);
      const head = await send(url, 'HEAD');
      assert.equal(head.status, 200); assert.equal(head.body.length, 0);
      for (const key of ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified']) assert.equal(head.headers[key], result.headers[key], key);
      const revalidated = await send(url, 'GET', {'if-none-match': result.headers.etag});
      assert.equal(revalidated.status, 304); assert.equal(revalidated.body.length, 0);
      if (etags.has(url)) {
        const crossed = await send(url, 'GET', {'if-none-match': etags.get(url)});
        assert.ok([200, 304].includes(crossed.status), url);
        if (crossed.status === 200) assert.equal(hash(crossed.body), next[path], url);
      }
      etags.set(url, result.headers.etag);
    }
    for (const game of ['thunder','tiger','match','golf','carrom','darts','ludo','jackaroo','domino','pool','bowling','run','towerlink']) {
      const result = await send('/play/' + game, 'GET', {'if-none-match': '*', 'if-modified-since': 'Wed, 01 Jan 2098 00:00:00 GMT'});
      assert.equal(result.status, 200, game); assert.equal(result.headers['cache-control'], 'no-store', game);
      const relative = ['thunder', 'tiger'].includes(game) ? 'platform/legacy/dist/' + game + '.html' : 'platform/arena/dist/index.html';
      assert.equal(hash(result.body), (selected === 'forward' ? next : old)[relative], game);
    }
    assert.equal((await send('/arena/assets/does-not-exist-Ab12_cdE.js')).status, 404);
  }
  t.diagnostic(JSON.stringify({requests, apiServedMissingAssets: missing.length, platformAssetsHashOnly: publicMissing.length,
    directions: ['rollback', 'forward', 'rollback'], tlsOrNginxExercised: false, gameplayProtocolOrDeviceAcceptance: false}));
});
