/** Exports exactly the original PCM used by GameAudio; no external audio. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { AUDIO_SAMPLE_RATE, renderMusicPcm, renderSoundPcm, type SoundCue } from '../src/ui/audio';

const destination = resolve('output/audio');
await mkdir(destination, { recursive: true });
function wav(pcm: Float32Array): Buffer {
  const bytes = Buffer.alloc(44 + pcm.length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(AUDIO_SAMPLE_RATE, 24); bytes.writeUInt32LE(AUDIO_SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(pcm.length * 2, 40);
  for (let index = 0; index < pcm.length; index++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[index])) * 32767), 44 + index * 2);
  return bytes;
}
const records = [];
const cues: SoundCue[] = ['click', 'spin', 'land', 'small', 'big', 'scatter'];
const renders: Array<[string, Float32Array]> = [['thunder-throne-music', renderMusicPcm()], ...cues.map(cue => [cue === 'small' || cue === 'big' ? `${cue}-win` : cue, renderSoundPcm(cue)] as [string, Float32Array])];
for (const [name, pcm] of renders) {
  let peak = 0; let squares = 0; let nonfinite = 0;
  for (const value of pcm) { if (!Number.isFinite(value)) nonfinite++; peak = Math.max(peak, Math.abs(value)); squares += value * value; }
  const rms = Math.sqrt(squares / pcm.length);
  if (nonfinite || rms < 0.015 || peak >= 1) throw new Error(`${name}: invalid or silent PCM`);
  const bytes = wav(pcm);
  await writeFile(resolve(destination, `${name}.wav`), bytes);
  records.push({ file: `${name}.wav`, durationSeconds: pcm.length / AUDIO_SAMPLE_RATE, sampleRate: AUDIO_SAMPLE_RATE, channels: 1, peak, rms, nonfinite, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(resolve(destination, 'validation.json'), JSON.stringify({ method: 'Export of the same original PCM generators played by GameAudio; levels are before user channel gain.', records }, null, 2) + '\n');
console.log(JSON.stringify({ destination, records }, null, 2));
