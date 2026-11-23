import { createPovServer } from "./povServer";

// Local/private development only. Explicitly loopback-bound; no accidental public exposure.
const port = Number(process.env.POV_PORT ?? "8791");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("POV_PORT must be an integer port");
const server = createPovServer({ port, host: "127.0.0.1", log: console.log });
server.ready.catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
const shutdown = () => {
  void server.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
