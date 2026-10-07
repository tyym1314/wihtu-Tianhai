/** Restore reviewed, immutable browser assets after all Vite clean builds finish. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {lstat, mkdir, rename, rm} from 'node:fs/promises';
import https from 'node:https';
import {join, resolve} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {fileURLToPath} from 'node:url';

const helper = fileURLToPath(new URL('../deploy/release_build.py', import.meta.url));
const repository = fileURLToPath(new URL('../../', import.meta.url));
const maxBytes = 512 * 1024 * 1024;

function inspect(root, action, archive) {
  const child = spawnSync('python3', [helper, action, '--root', root,
    ...(archive ? ['--archive', archive] : [])], {encoding: 'utf8'});
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr.trim() || 'RETAINED_ASSET_VALIDATION_FAILED');
  return JSON.parse(child.stdout);
}

async function safeDirectory(root, relative) {
  let current = root;
  for (const component of relative.split('/')) {
    current = join(current, component);
    await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'UNSAFE_RETAINED_CACHE_DIRECTORY');
  }
  return current;
}

async function verifyBundle(path, bundle) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'UNSAFE_RETAINED_CACHE_FILE');
  assert.equal(info.size, bundle.bytes, 'RETAINED_BUNDLE_SIZE_MISMATCH');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assert.equal(hash.digest('hex'), bundle.sha256, 'RETAINED_BUNDLE_HASH_MISMATCH');
}

/** No redirects, cookies, credentials or disabled TLS verification are supported. */
export async function downloadRetainedBundle(bundle, destination) {
  const url = new URL(bundle.url);
  assert.ok(url.protocol === 'https:' && !url.username && !url.password
    && !url.hash && !url.search && (!url.port || url.port === '443'), 'RETAINED_BUNDLE_HTTPS_REQUIRED');
  assert.ok(Number.isSafeInteger(bundle.bytes) && bundle.bytes > 0 && bundle.bytes <= maxBytes,
    'INVALID_RETAINED_BUNDLE_SIZE');
  assert.match(bundle.sha256, /^[a-f0-9]{64}$/u, 'INVALID_RETAINED_BUNDLE_HASH');
  const response = await new Promise((accept, reject) => {
    const request = https.get(url, {
      rejectUnauthorized: true,
      headers: {'Accept': 'application/gzip', 'Accept-Encoding': 'identity'},
    }, result => {
      if (result.statusCode !== 200) {
        result.resume();
        reject(new Error(`RETAINED_BUNDLE_HTTP_${result.statusCode}: redirects are not followed`));
      } else if (result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity') {
        result.resume();
        reject(new Error('RETAINED_BUNDLE_UNEXPECTED_CONTENT_ENCODING'));
      } else if (result.headers['content-length'] !== undefined
        && Number(result.headers['content-length']) !== bundle.bytes) {
        result.resume();
        reject(new Error('RETAINED_BUNDLE_SIZE_MISMATCH'));
      } else accept(result);
    });
    request.setTimeout(30000, () => request.destroy(new Error('RETAINED_BUNDLE_DOWNLOAD_TIMEOUT')));
    request.on('error', reject);
  });
  let received = 0;
  const hash = createHash('sha256');
  const bounded = new Transform({transform(chunk, encoding, callback) {
    received += chunk.length;
    if (received > bundle.bytes) return callback(new Error('RETAINED_BUNDLE_SIZE_EXCEEDED'));
    hash.update(chunk);
    callback(null, chunk);
  }});
  await pipeline(response, bounded, createWriteStream(destination, {flags: 'wx', mode: 0o600}));
  assert.equal(received, bundle.bytes, 'RETAINED_BUNDLE_SIZE_MISMATCH');
  assert.equal(hash.digest('hex'), bundle.sha256, 'RETAINED_BUNDLE_HASH_MISMATCH');
}

export async function materializeRetainedAssets(root = repository) {
  root = resolve(root);
  // Python owns the lock, dependency and tar policy; validate before cache writes or network I/O.
  const {bundle} = inspect(root, 'retained-inspect');
  const cache = await safeDirectory(root, 'platform/.local/retained-assets');
  const archive = join(cache, bundle.sha256 + '.tar.gz');
  try {
    await verifyBundle(archive, bundle);
  } catch (error) {
    // Corrupt and symlinked cache entries fail closed; do not silently erase evidence.
    if (error.code !== 'ENOENT') throw error;
    const pending = join(cache, bundle.sha256 + '.' + randomUUID() + '.part');
    try {
      await downloadRetainedBundle(bundle, pending);
      await verifyBundle(pending, bundle);
      await rename(pending, archive);
    } finally {
      await rm(pending, {force: true});
    }
  }
  return inspect(root, 'retained-materialize', archive);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await materializeRetainedAssets(process.argv[2] || repository)));
}
