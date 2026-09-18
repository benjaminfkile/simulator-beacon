// Thin caller: loads configuration, hands it to `startService`, and wires
// SIGTERM and SIGINT to the returned stop. The wiring itself lives in
// `src/service.ts`.

import pino from "pino";
import { loadConfig, ConfigError } from "./config.js";
import { startService } from "./service.js";

async function main(): Promise<void> {
  const config = (() => {
    try {
      return loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) {
        process.stderr.write(`config error: ${err.message}\n`);
        process.exit(2);
      }
      throw err;
    }
  })();

  const log = pino({ level: config.logLevel });
  const service = await startService(config, { logger: log });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutdown");
    await service.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
