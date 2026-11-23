/** Bootstrap: `tsx src/index.ts` — signaling server on SIGNAL_PORT (override with PORT). */
import { SIGNAL_PORT } from '@spar/protocol';
import { replay } from '@spar/sim';
import { createSignalServer } from './server';

const port = Number(process.env.PORT) || SIGNAL_PORT;
const server = createSignalServer({
  port,
  replayer: { replay },
  log: (msg) => console.log(`[signal ${new Date().toISOString()}] ${msg}`),
});

const shutdown = () => {
  server.close().then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
