import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

export const createBrowserGateway = async (directory: string, upstream: string) => {
  const key = join(directory, "browser.key");
  const cert = join(directory, "browser.pem");

  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-subj",
    "/CN=apps.example.test",
    "-days",
    "1",
  ]);

  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      const handle = async () => {
        const headers = new Headers();

        for (let index = 0; index < request.rawHeaders.length; index += 2) {
          headers.append(
            z.string().parse(request.rawHeaders[index]),
            z.string().parse(request.rawHeaders[index + 1]),
          );
        }

        headers.set("x-fixture-origin", `https://${request.headers.host}`);
        const chunks: Buffer[] = [];

        for await (const chunk of request) chunks.push(z.instanceof(Buffer).parse(chunk));
        const init: RequestInit = { method: request.method ?? "GET", headers, redirect: "manual" };

        if (chunks.length) init.body = Buffer.concat(chunks);
        const result = await fetch(new URL(request.url ?? "/", upstream), init);

        const body = Buffer.from(await result.arrayBuffer());

        // Node fetch has already decoded the upstream body.
        for (const [name, value] of result.headers)
          if (
            ![
              "set-cookie",
              "content-encoding",
              "content-length",
              "transfer-encoding",
              "connection",
            ].includes(name)
          )
            response.setHeader(name, value);
        response.setHeader("set-cookie", result.headers.getSetCookie());
        response.setHeader("content-length", body.byteLength);
        response.writeHead(result.status).end(body);
      };

      void handle().catch(() => response.writeHead(500).end());
    },
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = z.object({ port: z.number() }).parse(server.address()).port;

  return {
    port,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};
