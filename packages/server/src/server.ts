import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { Registry } from "./registry.js";
import { Stores } from "./stores.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  dataDir: string;
  webRoot?: string | undefined;
}

export interface RunningServer {
  url: string;
  registry: Registry;
  stores: Stores;
  close(): Promise<void>;
}

export async function startServer({ port = 4317, host = "127.0.0.1", dataDir, webRoot }: ServerOptions): Promise<RunningServer> {
  const registry = new Registry(dataDir);
  const stores = new Stores(dataDir);
  stores.watch();
  const app = createApp({ registry, stores, webRoot });
  const { server, address } = await new Promise<{ server: Server; address: { port: number } }>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port, hostname: host }, (info) => resolve({ server: s as Server, address: info }));
    (s as Server).once("error", reject);
  });
  const shownHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return {
    url: `http://${shownHost}:${address.port}`,
    registry,
    stores,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          stores.close();
          registry.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
