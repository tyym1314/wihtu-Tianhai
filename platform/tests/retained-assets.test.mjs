import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import https from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {test, mock} from 'node:test';
import {downloadRetainedBundle, materializeRetainedAssets} from '../scripts/retained-assets.mjs';

const contents = Buffer.from('a verified compressed archive fixture');
const bundle = {url: 'https://example.com/retained.tar.gz', bytes: contents.length,
  sha256: createHash('sha256').update(contents).digest('hex')};

function respond({status = 200, headers = {}, bytes = contents, error} = {}) {
  return mock.method(https, 'get', (url, options, callback) => {
    assert.equal(options.rejectUnauthorized, true, 'TLS must remain strict even under inherited insecure env');
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    const request = new EventEmitter();
    request.setTimeout = () => request;
    queueMicrotask(() => {
      if (error) return request.emit('error', error);
      const response = Readable.from([bytes]);
      response.statusCode = status;
      response.headers = headers;
      callback(response);
    });
    return request;
  });
}

test('retained HTTPS download verifies size/hash and explicitly enables TLS validation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oasis-retained-download-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const transport = respond({headers: {'content-length': String(contents.length)}});
  t.after(() => transport.mock.restore());
  await downloadRetainedBundle(bundle, join(directory, 'asset.tar.gz'));
  assert.deepEqual(await readFile(join(directory, 'asset.tar.gz')), contents);
});

test('redirects, bad HTTP statuses and encoded responses are rejected without writing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oasis-retained-download-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const response of [{status: 302, headers: {location: 'https://elsewhere.test/other.tar.gz'}},
    {status: 404}, {headers: {'content-encoding': 'gzip'}}, {headers: {'content-length': '1'}}]) {
    const transport = respond(response);
    try {
      await assert.rejects(downloadRetainedBundle(bundle, join(directory, 'asset.tar.gz')), /RETAINED_BUNDLE_/u);
      assert.equal(transport.mock.callCount(), 1);
    } finally { transport.mock.restore(); }
  }
  assert.deepEqual(await readdir(directory), []);
});

test('streamed oversize and wrong digest do not pass the download gate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oasis-retained-download-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const [index, bytes] of [Buffer.concat([contents, Buffer.from('x')]), Buffer.alloc(contents.length)].entries()) {
    const transport = respond({bytes});
    try {
      await assert.rejects(downloadRetainedBundle(bundle, join(directory, `asset-${index}.tar.gz`)), /RETAINED_BUNDLE_(SIZE_EXCEEDED|HASH_MISMATCH)/u);
    } finally { transport.mock.restore(); }
  }
});

test('TLS transport errors are propagated and HTTP/auth URLs fail before transport', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oasis-retained-download-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const transport = respond({error: new Error('CERT_HAS_EXPIRED')});
  t.after(() => transport.mock.restore());
  for (const url of ['http://example.com/retained.tar.gz', 'https://secret@example.com/retained.tar.gz']) {
    await assert.rejects(downloadRetainedBundle({...bundle, url}, join(directory, 'asset.tar.gz')), /RETAINED_BUNDLE_HTTPS_REQUIRED/u);
  }
  assert.equal(transport.mock.callCount(), 0);
  await assert.rejects(downloadRetainedBundle(bundle, join(directory, 'asset.tar.gz')), /CERT_HAS_EXPIRED/u);
  assert.deepEqual(await readdir(directory), []);
});

test('download refuses to replace a destination file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oasis-retained-download-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const destination = join(directory, 'asset.tar.gz');
  await writeFile(destination, 'original');
  const transport = respond();
  t.after(() => transport.mock.restore());
  await assert.rejects(downloadRetainedBundle(bundle, destination), error => error.code === 'EEXIST');
  assert.equal(await readFile(destination, 'utf8'), 'original');
});

function retainedFixture(root) {
  const script = `
import hashlib, io, json, pathlib, sys, tarfile
root=pathlib.Path(sys.argv[1]); (root/'platform').mkdir()
data=b'export default 1;'; name='platform/arena/dist/assets/Old-12345678.js'
archive=root/'fixture.tar.gz'
with tarfile.open(archive,'w:gz',format=tarfile.USTAR_FORMAT) as tar:
 info=tarfile.TarInfo(name); info.size=len(data); tar.addfile(info,io.BytesIO(data))
asset={'path':name,'publicPath':'/arena/assets/Old-12345678.js','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'contentType':'application/javascript','sources':[{'release':'20261007-04','manifest_sha256':'a'*64}],'dependencies':[]}
bundle={'url':'https://example.com/retained.tar.gz','bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}
(root/'platform/retained-assets.lock.json').write_text(json.dumps({'schema':'oasis-retained-static-v1','bundle':bundle,'assets':[asset]}))
print(json.dumps(bundle))
`;
  const result = spawnSync('python3', ['-c', script, root], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('fresh output restores from pinned HTTPS bundle and subsequent clean builds use verified cache', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oasis-retained-build-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  retainedFixture(directory);
  const bytes = await readFile(join(directory, 'fixture.tar.gz'));
  const transport = respond({bytes, headers: {'content-length': String(bytes.length)}});
  t.after(() => transport.mock.restore());
  const first = await materializeRetainedAssets(directory);
  assert.equal(first.materialized, 1);
  assert.equal(await readFile(join(directory, 'platform/arena/dist/assets/Old-12345678.js'), 'utf8'), 'export default 1;');
  await rm(join(directory, 'platform/arena/dist'), {recursive: true});
  const next = await materializeRetainedAssets(directory);
  assert.equal(next.materialized, 1);
  assert.equal(transport.mock.callCount(), 1, 'cache must avoid a second download but restore after Vite empties dist');
});

test('corrupt retained cache fails closed without overwriting it or restoring output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'oasis-retained-build-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const pinned = retainedFixture(directory);
  const bytes = await readFile(join(directory, 'fixture.tar.gz'));
  const transport = respond({bytes});
  t.after(() => transport.mock.restore());
  await materializeRetainedAssets(directory);
  const cache = join(directory, 'platform/.local/retained-assets', pinned.sha256 + '.tar.gz');
  await writeFile(cache, 'corrupt');
  await rm(join(directory, 'platform/arena/dist'), {recursive: true});
  await assert.rejects(materializeRetainedAssets(directory), /RETAINED_BUNDLE_SIZE_MISMATCH/u);
  assert.equal(await readFile(cache, 'utf8'), 'corrupt');
  assert.equal(transport.mock.callCount(), 1);
  await assert.rejects(readFile(join(directory, 'platform/arena/dist/assets/Old-12345678.js')), error => error.code === 'ENOENT');
});
