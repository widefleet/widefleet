import { CRC32C } from "@google-cloud/storage";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { z } from "zod";

// A loopback protocol fixture exercises the real SDKs without credentials or cloud resources.
export const createStorageFixture = async (provider: "azure" | "gcs") => {
  const objects = new Map<string, Buffer>();
  const requests: { method: string; key: string; conditional: boolean }[] = [];
  const failures: Error[] = [];
  let deny = false;
  let failDeletion = false;
  let listingPages = 0;
  let duplicateStatus = provider === "azure" ? 409 : 412;
  let uploadFailure: { status: number; code: string } | undefined;

  const xml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const checksum = (bytes: Buffer) => {
    const hash = new CRC32C();

    hash.update(bytes);

    return hash.toString();
  };

  const metadata = (key: string, bytes: Buffer) => ({
    name: key,
    bucket: "artifacts",
    size: String(bytes.length),
    generation: "1",
    crc32c: checksum(bytes),
    contentType: "application/octet-stream",
  });

  const failure = (
    response: ServerResponse,
    status: number,
    code = status === 404
      ? "BlobNotFound"
      : status === 409
        ? "BlobAlreadyExists"
        : status === 412
          ? "ConditionNotMet"
          : "AuthorizationFailure",
  ) => {
    response.statusCode = status;

    if (provider === "azure") response.setHeader("x-ms-error-code", code);

    response.setHeader(
      "content-type",
      provider === "azure" ? "application/xml" : "application/json",
    );
    response.end(
      provider === "azure"
        ? `<Error><Code>${code}</Code><Message>Fixture error</Message></Error>`
        : JSON.stringify({ error: { code: status, message: "Fixture error" } }),
    );
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    const listing =
      method === "GET" &&
      (provider === "azure"
        ? url.searchParams.get("comp") === "list"
        : url.pathname.endsWith("/o") && !url.pathname.startsWith("/upload/"));

    const key =
      provider === "azure"
        ? decodeURIComponent(url.pathname.replace(/^\/account\/artifacts\/?/, ""))
        : (url.searchParams.get("name") ?? decodeURIComponent(url.pathname.split("/o/")[1] ?? ""));

    const conditional =
      provider === "azure"
        ? request.headers["if-none-match"] === "*"
        : url.searchParams.get("ifGenerationMatch") === "0";

    requests.push({ method, key, conditional });

    if (deny || (failDeletion && method === "DELETE")) return failure(response, 403);

    if (listing) {
      listingPages++;
      const prefix = url.searchParams.get("prefix") ?? "";

      const offset = Number(
        url.searchParams.get(provider === "azure" ? "marker" : "pageToken") ?? 0,
      );

      const keys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
      const page = keys.slice(offset, offset + 2);
      const next = offset + 2 < keys.length ? String(offset + 2) : "";

      if (provider === "azure") {
        response.setHeader("content-type", "application/xml");
        response.end(
          `<EnumerationResults ServiceEndpoint="http://localhost/account" ContainerName="artifacts"><Blobs>${page.map((name) => `<Blob><Name>${xml(name)}</Name><Properties><Content-Length>${objects.get(name)?.length}</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob>`).join("")}</Blobs><NextMarker>${next}</NextMarker></EnumerationResults>`,
        );
      } else {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            items: page.map((name) => metadata(name, objects.get(name) ?? Buffer.alloc(0))),
            ...(next ? { nextPageToken: next } : { kind: "storage#objects" }),
          }),
        );
      }

      return;
    }

    if (method === "PUT" || method === "POST") {
      const raw = await buffer(request);

      if (uploadFailure) return failure(response, uploadFailure.status, uploadFailure.code);

      if (conditional && objects.has(key)) return failure(response, duplicateStatus);

      let bytes = raw;

      if (provider === "gcs") {
        const boundary = z.string().parse(request.headers["content-type"]).split("boundary=")[1];

        if (boundary === undefined) throw new Error("Missing multipart boundary");
        const secondPart = raw.indexOf(`--${boundary}`, raw.indexOf("\r\n\r\n") + 4);
        const start = raw.indexOf("\r\n\r\n", secondPart) + 4;
        const end = raw.indexOf(`\r\n--${boundary}`, start);

        if (secondPart < 0 || start < 4 || end < 0) throw new Error("Invalid multipart upload");
        bytes = raw.subarray(start, end);
      }

      objects.set(key, bytes);
      response.statusCode = provider === "azure" ? 201 : 200;
      response.setHeader("etag", '"fixture-etag"');

      if (provider === "gcs") response.setHeader("content-type", "application/json");
      response.end(provider === "gcs" ? JSON.stringify(metadata(key, bytes)) : undefined);

      return;
    }

    const bytes = objects.get(key);

    if (bytes === undefined) return failure(response, 404);

    if (method === "DELETE") {
      objects.delete(key);
      response.statusCode = provider === "azure" ? 202 : 204;
      response.end();

      return;
    }

    if (provider === "gcs" && url.searchParams.get("alt") !== "media") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(metadata(key, bytes)));

      return;
    }

    response.setHeader("content-length", bytes.length);
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("etag", '"fixture-etag"');

    if (provider === "gcs") response.setHeader("x-goog-hash", `crc32c=${checksum(bytes)}`);
    response.end(method === "HEAD" ? undefined : bytes);
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((cause: Error) => {
      failures.push(cause);
      response.statusCode = 500;
      response.end("Fixture failure");
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z.object({ port: z.number() }).parse(server.address());

  return {
    url: `http://127.0.0.1:${address.port}`,
    objects,
    requests,
    failures,
    deny: (value: boolean) => {
      deny = value;
    },
    failDeletion: (value: boolean) => {
      failDeletion = value;
    },
    duplicateStatus: (value: 409 | 412) => {
      duplicateStatus = value;
    },
    failUpload: (status: number, code: string) => {
      uploadFailure = { status, code };
    },
    listingPages: () => listingPages,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
};
