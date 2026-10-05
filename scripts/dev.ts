import { spawn } from 'node:child_process';
const children = [spawn('npm', ['run', 'dev:server'], { stdio: 'inherit' }), spawn('npm', ['run', 'dev:web'], { stdio: 'inherit' })];
function stop() { for (const child of children) child.kill('SIGTERM'); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => { if (code) { stop(); process.exitCode = code; } });
