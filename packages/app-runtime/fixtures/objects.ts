import { publishedApp } from "@platform/contracts";
import { workerCode } from "../src/worker.ts";
import { digest } from "./digest.ts";
import type { ParentEnvironment } from "../src/types.ts";

export { Objects } from "../src/objects.ts";

export { RuntimeObserver } from "../src/runtime-observer.ts";

export { AppSecrets } from "../src/app-secrets.ts";

export { Assets } from "../src/assets.ts";

export { Gateway } from "../src/egress.ts";

const source = `export default {
  async fetch(request, env) {
    const bucket = env.FILES;
    const path = new URL(request.url).pathname;
    if (path.endsWith('/resume')) {
      const handle = bucket.resumeMultipartUpload('private-key', 'private-upload-id');
      return Response.json({ handle: typeof handle.uploadPart === 'function' });
    }
    if (path.endsWith('/stream')) {
      const value = await bucket.get('private-stream');
      return new Response(value.body);
    }
    const missingHead = await bucket.head('private-missing');
    const missingGet = await bucket.get('private-missing');
    const stream = new FixedLengthStream(12);
    const writer = stream.writable.getWriter();
    const writing = (async () => {
      await writer.write(new TextEncoder().encode('private-'));
      await writer.write(new TextEncoder().encode('body'));
      await writer.close();
    })();
    const written = await bucket.put('private-stream', stream.readable, {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { secret: 'private-metadata' }
    });
    await writing;
    const head = await bucket.head('private-stream');
    const found = await bucket.get('private-stream');
    const bodyUsedBefore = found.bodyUsed;
    const value = await found.text();
    const bodyUsedAfter = found.bodyUsed;
    const range = await bucket.get('private-stream', { range: { offset: 2, length: 4 } });
    const rangeValue = await range.text();
    const conditional = await bucket.get('private-stream', { onlyIf: { etagDoesNotMatch: written.etag } });
    const allowed = await bucket.get('private-stream', { onlyIf: { etagMatches: written.etag } });
    const allowedValue = await allowed.text();
    const rejectedPut = await bucket.put('private-stream', 'replacement', { onlyIf: { etagMatches: 'wrong' } });
    const unchanged = await (await bucket.get('private-stream')).text();
    await bucket.put('private-second', 'second');
    const firstPage = await bucket.list({ limit: 1 });
    const secondPage = await bucket.list({ cursor: firstPage.cursor });
    await bucket.delete('private-second');
    await bucket.delete(['private-stream', 'private-missing', 'private-stream']);
    await bucket.delete([]);
    const empty = await bucket.list();
    const upload = await bucket.createMultipartUpload('private-multipart');
    const part = await upload.uploadPart(1, 'multipart-body');
    const resumed = bucket.resumeMultipartUpload(upload.key, upload.uploadId);
    const completed = await resumed.complete([part]);
    const multipartValue = await (await bucket.get('private-multipart')).text();
    const cancelled = await bucket.createMultipartUpload('private-aborted');
    await cancelled.abort();
    let invalidInputRejected = false;
    try { await bucket.list({ limit: 'invalid' }); }
    catch { invalidInputRejected = true; }
    const nativeErrors = [];
    for (const invoke of [
      () => bucket.get('x'.repeat(1025)),
      () => bucket.put('private-bad-digest', 'body', { md5: '0'.repeat(32) }),
      () => bucket.list({ limit: 0 }),
      () => resumed.uploadPart(0, 'bad-part'),
      () => resumed.complete([])
    ]) {
      try { await invoke(); nativeErrors.push(null); }
      catch (error) { nativeErrors.push(error.message); }
    }
    await bucket.delete('private-multipart');
    // Keep a body available for the separate streaming-response check.
    await bucket.put('private-stream', 'private-body');
    return Response.json({
      missingHead, missingGet, size: head.size, metadata: head.customMetadata,
      contentType: head.httpMetadata.contentType, value, bodyUsedBefore, bodyUsedAfter,
      rangeValue, range: range.range,
      conditionalHasBody: 'body' in conditional, allowedValue, rejectedPut, unchanged,
      pages: [firstPage.objects.length, secondPage.objects.length], truncated: firstPage.truncated,
      empty: empty.objects.length, completedSize: completed.size, multipartValue, nativeErrors, invalidInputRejected,
      unexpectedBindings: Object.keys(env).filter(name => ![
        'FILES', 'ASSETS', 'WIDEFLEET_R2_FILES', 'WIDEFLEET_DEPLOYMENT_ID', 'WIDEFLEET_SECRETS', 'WIDEFLEET_ORIGIN'
      ].includes(name))
    });
  }
};`;

export default {
  async fetch(request, env, ctx) {
    const service = new URL(request.url).pathname.startsWith("/service");

    const appId = service
      ? "a0000000-0000-4000-8000-000000000004"
      : "a0000000-0000-4000-8000-000000000001";

    const deploymentId = service
      ? "a0000000-0000-4000-8000-000000000003"
      : "a0000000-0000-4000-8000-000000000002";

    const sha256 = await digest(source);
    const prefix = `apps/${appId}`;
    await env.WIDEFLEET_PACKAGES.put(`${prefix}/modules/${sha256}`, source);
    const modules = [{ name: "child.js", type: "esm", sha256, size: source.length }];

    const metadata = {
      main_module: "child.js",
      compatibility_date: "2026-10-01",
      bindings: [{ type: "r2_bucket", name: "FILES", bucket_name: "fixture" }],
    };

    const nativeBindings = { FILES: service ? "SERVICE_OBJECTS" : "APP_OBJECTS" };

    const worker = env.WIDEFLEET_LOADER.get(service ? "service" : "app", () =>
      workerCode(
        publishedApp.parse({
          id: appId,
          appId,
          deploymentId,
          version: deploymentId,
          hostname: "objects.example.test",
          organizationId: service ? "objects-fixture" : undefined,
          metadata: {
            ...metadata,
            web: !service,
            entrypoints: service ? ["default"] : [],
            assets: { binding: "ASSETS", upload_session: deploymentId },
          },
          manifest: {},
          modules,
          nativeBindings,
          network: { revision: 1, policy: { backend: [], browser: [] } },
        }),
        env,
        ctx,
      ),
    );

    return worker.getEntrypoint().fetch(request);
  },
} satisfies ExportedHandler<ParentEnvironment>;
