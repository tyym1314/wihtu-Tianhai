import { resolve } from 'node:path';
import { createDemoServer } from './app.js';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');

const server = await createDemoServer({
  storePath: resolve(process.env.DEMO_DATA_PATH || '.data/demo-sessions.json'),
  staticDirectory: resolve('dist'),
});

server.listen(port, host, () => {
  console.log(`Thunder Throne demo: http://${host}:${port}`);
  console.log('Isolated demo credits only. Run one server process per data file.');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
