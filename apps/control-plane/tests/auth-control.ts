import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { authConfiguration, type AuthConfiguration } from "@platform/auth-proxy";
import { authControlPath, configurationRevision } from "@platform/auth-proxy/publication";

// Settings/API/browser fixtures exercise HTTP publication. Packaged tests use the real worker.
export const createAuthControl = async (directory: string) => {
  const key = "local-auth-control-key-never-deploy";
  let configuration: AuthConfiguration | null = null;
  let revision = "";
  let available = true;
  let publications = 0;

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "control-token"), key, { mode: 0o600 });

  const handle = async (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => {
    if (request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(403).end();

      return;
    }

    if (!available) {
      response.writeHead(503).end();

      return;
    }

    if (request.url !== `${authControlPath}/configuration`) {
      response.writeHead(404).end();

      return;
    }

    if (request.method === "PUT") {
      const chunks: Buffer[] = [];

      for await (const chunk of request) chunks.push(z.instanceof(Buffer).parse(chunk));
      configuration = authConfiguration.parse(JSON.parse(Buffer.concat(chunks).toString()));
      revision = await configurationRevision(configuration);
      publications++;
      response.writeHead(204).end();
    } else {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          revision,
          state: configuration ? "active" : "waiting",
          message: configuration
            ? "The sign-in configuration is published."
            : "Waiting for configuration",
        }),
      );
    }
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.writeHead(500).end());
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z.object({ port: z.number() }).parse(server.address());

  return {
    url: `http://127.0.0.1:${address.port}`,
    read: () => ({ configuration, revision, publications }),
    available: (value: boolean) => {
      available = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
