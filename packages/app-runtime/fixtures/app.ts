import { connect } from "cloudflare:sockets";

type FixtureEnvironment = {
  DB: D1Database;
  FILES: R2Bucket;
  KV: KVNamespace;
  JOBS: Queue<{ mode: string }>;
  ASSETS: Fetcher;
  UPSTREAM: Fetcher;
};

export default {
  async fetch(request, env) {
    const query = new URL(request.url).searchParams;
    const operation = query.get("operation");

    try {
      if (operation === "log") {
        console.error("fixture console error");
        console.error(
          JSON.stringify({
            widefleet: 1,
            source: "browser",
            kind: "error",
            message: "fixture older browser error",
            buildId: "fixture-older-build",
            deploymentId: null,
          }),
        );

        return Response.json({ ok: true });
      }

      if (operation === "env") return Response.json(Object.keys(env));

      if (operation === "self") return Response.json(Object.is(self, globalThis));

      if (operation === "abort") {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        return Response.json({ completed: true });
      }

      if (operation === "cancel-upstream")
        return env.UPSTREAM.fetch(`https://cancellation.fixture/?id=${query.get("id")}`, {
          signal: request.signal,
        });

      if (operation === "fetch") {
        const redirect = query.get("redirect") ?? "follow";

        if (redirect !== "follow" && redirect !== "error" && redirect !== "manual")
          throw new Error("Invalid redirect mode");
        const headers = new Headers();

        if (query.has("host")) headers.set("host", query.get("host") ?? "");

        const response = await fetch(query.get("target") ?? "", {
          redirect,
          headers,
        });

        return Response.json({
          status: response.status,
          body: await response.text(),
          redirected: response.redirected,
        });
      }

      if (operation === "proxy-upload")
        return fetch("https://stream.fixture/upload", { method: "POST", body: request.body });

      if (operation === "tcp") {
        const socket = connect(query.get("target") ?? "");
        await socket.opened;
        await socket.close();

        return Response.json({ connected: true });
      }

      if (operation === "websocket") {
        const socket = new WebSocket(query.get("target") ?? "");
        socket.close();

        return Response.json({ connected: true });
      }

      if (operation === "database-read")
        return Response.json(
          await env.DB.prepare("SELECT value FROM fixture").first<number>("value"),
        );

      if (operation === "database") {
        await env.DB.exec("CREATE TABLE fixture (value INTEGER UNIQUE)");
        const session = env.DB.withSession("first-primary");
        await session.batch([session.prepare("INSERT INTO fixture VALUES (?)").bind(42)]);
        let rolledBack = false;

        try {
          await env.DB.batch([
            env.DB.prepare("INSERT INTO fixture VALUES (43)"),
            env.DB.prepare("INSERT INTO fixture VALUES (42)"),
          ]);
        } catch {
          rolledBack =
            (await env.DB.prepare("SELECT value FROM fixture WHERE value = 43").first()) === null;
        }

        return Response.json({
          value: await session.prepare("SELECT value FROM fixture").first<number>("value"),
          rows: await session.prepare("SELECT value FROM fixture").raw({ columnNames: true }),
          bookmark: session.getBookmark(),
          rolledBack,
        });
      }

      if (operation === "objects") {
        await env.FILES.put("照片/Grüße", new Response("fixture body").body, {
          httpMetadata: new Headers({ "content-type": "text/plain" }),
          customMetadata: { kind: "照片" },
        });
        const object = await env.FILES.get("照片/Grüße");

        if (!object) throw new Error("Missing object");
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        const partial = await env.FILES.get("照片/Grüße", { range: { offset: 0, length: 7 } });

        const condition = await env.FILES.get("照片/Grüße", {
          onlyIf: { etagDoesNotMatch: object.etag },
        });

        const upload = await env.FILES.createMultipartUpload("分片");
        const part = await upload.uploadPart(1, "part");
        await env.FILES.resumeMultipartUpload(upload.key, upload.uploadId).complete([part]);
        const multipart = await env.FILES.get("分片");
        await env.FILES.put("large", new Uint8Array(5 * 1024 * 1024).fill(42));
        const large = await env.FILES.get("large");
        await env.FILES.delete(["large", "分片"]);

        if (!partial || !condition || !multipart || !large)
          throw new Error("Missing fixture objects");

        return Response.json({
          text: await object.text(),
          contentType: headers.get("content-type"),
          key: object.key,
          metadata: object.customMetadata,
          range: await partial.text(),
          conditionHasBody: "body" in condition,
          upload: await multipart.text(),
          missing: await env.FILES.head("分片"),
          bytes: (await large.arrayBuffer()).byteLength,
        });
      }

      if (operation === "kv") {
        await env.KV.put("json", JSON.stringify({ ok: true }), { metadata: { kind: "fixture" } });
        await env.KV.put("bytes", new Uint8Array([0, 128, 255]));
        await env.KV.put("stream", new Blob(["stream"]).stream());
        await env.KV.put("delete", "temporary");
        await env.KV.delete("delete");
        await env.KV.put("__proto__", "ordinary key");
        await env.KV.put("kunden/東京", "Grüße", { metadata: { label: "客户" } });
        await env.KV.put("empty", "");
        const listing = await env.KV.list();

        return Response.json({
          value: await env.KV.getWithMetadata("json", "json"),
          bytes: [
            ...new Uint8Array((await env.KV.get("bytes", "arrayBuffer")) ?? new ArrayBuffer(0)),
          ],
          text: await new Response(await env.KV.get("stream", "stream")).text(),
          unicode: await env.KV.getWithMetadata("kunden/東京"),
          empty: await new Response(await env.KV.get("empty", "stream")).text(),
          deleted: await env.KV.get("delete"),
          bulk: [...(await env.KV.get(["stream", "delete", "__proto__"]))],
          bulkJson: [...(await env.KV.getWithMetadata(["json", "delete"], "json"))],
          count: listing.keys.filter((key) => ["json", "bytes", "stream"].includes(key.name))
            .length,
        });
      }

      if (operation === "kv-stream-limit") {
        let error = "";

        try {
          await env.KV.put("oversized", request.body ?? new Uint8Array());
        } catch (cause) {
          error = String(cause);
        }

        return Response.json({ error, stored: await env.KV.get("oversized") });
      }

      if (operation === "queue-probe") {
        if (request.method === "POST") await env.JOBS.send({ mode: "probe" });

        return Response.json(await env.KV.get("probe"));
      }

      if (operation === "enqueue") {
        await env.JOBS.sendBatch(
          new Set(
            ["implicit", "retry", "dead", "settled", "background"].map((mode) => ({
              body: { mode },
            })),
          ),
        );

        return Response.json(true);
      }

      if (operation === "queue-result") {
        const result: Record<string, boolean> = {};

        for (const key of ["implicit", "retried", "dead", "settled", "background"])
          result[key] = (await env.KV.get(key)) === "yes";

        return Response.json(result);
      }

      if (operation === "cron-result") return Response.json((await env.KV.get("cron")) === "yes");

      return env.ASSETS.fetch(request);
    } catch (error) {
      return Response.json({
        error: String(error),
        stack: error instanceof Error ? error.stack : null,
      });
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(env.KV.put("cron", "yes"));
  },
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const mode = message.body.mode;

      if (batch.queue === "dead") {
        await env.KV.put("dead", "yes");
        continue;
      }

      if (mode === "probe") {
        await env.KV.put("probe", "probe-old");
        continue;
      }

      if (mode === "dead") {
        message.retry({ delaySeconds: 1 });
        continue;
      }

      if (mode === "retry" && message.attempts === 1) {
        message.retry({ delaySeconds: 1 });
        message.ack();
        continue;
      }

      if (mode === "retry") {
        await env.KV.put("retried", "yes");
        continue;
      }

      if (mode === "settled") {
        await env.KV.put("settled", "yes");
        message.ack();
        throw new Error("Fixture failure after acknowledgement");
      }

      if (mode === "background") {
        ctx.waitUntil(env.KV.put("background", "yes"));
        continue;
      }

      await env.KV.put("implicit", "yes");
    }
  },
} satisfies ExportedHandler<FixtureEnvironment, { mode: string }>;
