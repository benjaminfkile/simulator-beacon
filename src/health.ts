// GET /api/health on port 3000. Answers 503 until the config load and the
// leader poll have both run once; 200 otherwise. Nothing else is exposed.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface HealthProbe {
  configLoaded: boolean;
  leaderPolledOnce: boolean;
}

export interface HealthServer {
  close(): Promise<void>;
  port(): number;
}

export function startHealthServer(probe: () => HealthProbe, port = 3000): HealthServer {
  const server = createServer(handle(probe));
  server.listen(port);
  return {
    port() {
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : port;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function handle(probe: () => HealthProbe) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET" || req.url !== "/api/health") {
      res.statusCode = 404;
      res.setHeader("Cache-Control", "no-store");
      res.end();
      return;
    }
    const p = probe();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (!p.configLoaded || !p.leaderPolledOnce) {
      res.statusCode = 503;
      res.end(
        JSON.stringify({
          code: "unavailable",
          message: "starting up",
          details: null,
          requestId: "",
        }),
      );
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ status: "ok" }));
  };
}

export function _handleForTest(): (req: IncomingMessage, res: ServerResponse, probe: HealthProbe) => void {
  return (req, res, probe) => handle(() => probe)(req, res);
}

export { Server };
