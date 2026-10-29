import { WorkerEntrypoint } from "cloudflare:workers";
import { objectOperation } from "./object-protocol.ts";
import { runtimeExtension } from "#runtime-extension";
import type { ObjectObservation } from "./runtime-extension.ts";
import { nativeBinding } from "./native-binding.ts";
import type { BindingProperties, ParentEnvironment } from "./types.ts";
import { requireExecution } from "./execution.ts";

const metadata = (object: R2Object) => ({
  key: object.key,
  version: object.version,
  size: object.size,
  etag: object.etag,
  httpEtag: object.httpEtag,
  uploaded: object.uploaded.toISOString(),
  httpMetadata: object.httpMetadata,
  customMetadata: object.customMetadata,
  range: object.range,
  storageClass: object.storageClass,
  checksums: object.checksums.toJSON(),
});

export class Objects extends WorkerEntrypoint<
  ParentEnvironment,
  BindingProperties & { binding: string }
> {
  async #observe<Value>(
    operation: ObjectObservation["operation"],
    execute: () => Promise<Value>,
    resultOutcome: (result: Value) => ObjectObservation["outcome"] = () => "ok",
  ) {
    await requireExecution(this.env, this.ctx.props.identity);
    const observe = runtimeExtension.object;

    if (!observe) return execute();

    const timestamp = Date.now();
    let outcome: ObjectObservation["outcome"] = "error";

    try {
      const result = await execute();
      outcome = resultOutcome(result);

      return result;
    } finally {
      // Observe promise settlement, never body consumption. Delivery cannot replace
      // the native result; synchronous callback setup still runs in this worker.
      this.ctx.waitUntil(
        Promise.resolve().then(() =>
          observe(
            { timestamp, binding: this.ctx.props.binding, operation, count: 1, outcome },
            this.ctx.props.identity,
            (name, schema) => schema.parse(this.env[name]),
          ),
        ),
      );
    }
  }
  override async fetch(request: Request) {
    try {
      const input = objectOperation.parse(
        JSON.parse(decodeURIComponent(request.headers.get("x-widefleet-operation") ?? "null")),
      );

      const bucket = nativeBinding(this.env, this.ctx.props.name, "r2_bucket");

      switch (input.method) {
        case "get": {
          // SAFETY: Validated JSON omits undefined fields; date conditions were decoded above.
          const object = await this.#observe(
            "get",
            () => bucket.get(input.key, input.options as R2GetOptions),
            (result) =>
              result === null ? "not_found" : "body" in result ? "ok" : "precondition_failed",
          );

          if (!object) return new Response(null, { status: 404 });
          const hasBody = "body" in object;

          return new Response(hasBody ? object.body : null, {
            headers: {
              "x-widefleet-object": encodeURIComponent(JSON.stringify(metadata(object))),
              "x-widefleet-body": String(hasBody),
            },
          });
        }

        case "head": {
          const object = await this.#observe(
            "head",
            () => bucket.head(input.key),
            (result) => (result === null ? "not_found" : "ok"),
          );

          return Response.json(object ? metadata(object) : null);
        }

        case "put": {
          // SAFETY: Validated JSON omits undefined fields and contains native R2 option values.
          const object = await this.#observe(
            "put",
            () => bucket.put(input.key, request.body, input.options as R2PutOptions),
            (result) => (result === null ? "precondition_failed" : "ok"),
          );

          return Response.json(object ? metadata(object) : null);
        }

        case "delete":
          await this.#observe("delete", () => bucket.delete(input.keys));

          return Response.json(null);
        case "list": {
          // SAFETY: Optional JSON fields are absent, never explicitly undefined.
          const page = await this.#observe("list", () =>
            bucket.list(input.options as R2ListOptions),
          );

          return Response.json({ ...page, objects: page.objects.map(metadata) });
        }

        case "createMultipartUpload": {
          // SAFETY: Validated JSON contains the native multipart metadata options.
          const upload = await this.#observe("createMultipartUpload", () =>
            bucket.createMultipartUpload(input.key, input.options as R2MultipartOptions),
          );

          return Response.json({ key: upload.key, uploadId: upload.uploadId });
        }

        case "uploadPart": {
          const upload = bucket.resumeMultipartUpload(input.key, input.uploadId);

          return Response.json(
            await this.#observe("uploadPart", () =>
              upload.uploadPart(input.partNumber, request.body ?? new Uint8Array()),
            ),
          );
        }

        case "complete": {
          const upload = bucket.resumeMultipartUpload(input.key, input.uploadId);

          return Response.json(
            metadata(await this.#observe("complete", () => upload.complete(input.parts))),
          );
        }

        case "abort": {
          const upload = bucket.resumeMultipartUpload(input.key, input.uploadId);
          await this.#observe("abort", () => upload.abort());

          return Response.json(null);
        }
      }
    } catch (cause) {
      return Response.json({ error: String(cause) }, { status: 400 });
    }
  }
}
