import { z } from "zod";
import { publishedApp } from "@platform/contracts";
import { workerCode } from "../src/worker.ts";
import { digest } from "./digest.ts";
import { nativeBinding } from "../src/native-binding.ts";
import { observeDatabase } from "../src/d1-observation.ts";
import { exerciseDatabase } from "./d1-scenarios.ts";
import type { ParentEnvironment } from "../src/types.ts";

export { Database } from "../src/storage.ts";

export { AppSecrets } from "../src/app-secrets.ts";

export { Assets } from "../src/assets.ts";

export { Gateway } from "../src/egress.ts";

const app = {
  appId: "a0000000-0000-4000-8000-000000000001",
  deploymentId: "a0000000-0000-4000-8000-000000000002",
};

const service = {
  organizationId: "observer-fixture",
  appId: "a0000000-0000-4000-8000-000000000004",
  buildId: null,
  deploymentId: "a0000000-0000-4000-8000-000000000003",
};

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const db = nativeBinding(env, "NATIVE_DB", "d1");

    if (path === "/reset") {
      await db.exec(
        "CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, name TEXT, enabled INTEGER);\n" +
          "CREATE TABLE IF NOT EXISTS children(id INTEGER PRIMARY KEY, owner_id INTEGER);\n" +
          "CREATE TABLE IF NOT EXISTS counter(n INTEGER);\n" +
          "DELETE FROM items;\nDELETE FROM children;\nDELETE FROM counter;\n" +
          "INSERT INTO items VALUES(1,'one',1),(2,'two',0);\n" +
          "INSERT INTO children VALUES(10,1),(20,2);\nINSERT INTO counter VALUES(0);",
      );

      return new Response(null, { status: 204 });
    }

    if (path === "/state") {
      const internal = z
        .object({
          alwaysPrimarySession: z.custom<D1DatabaseSession>(
            (value) => z.object({ getBookmark: z.function() }).safeParse(value).success,
          ),
        })
        .parse(db);

      return Response.json({
        n: await db.prepare("SELECT n FROM counter").first("n"),
        unchanged:
          !Object.hasOwn(internal.alwaysPrimarySession, "_send") &&
          !Object.hasOwn(db, "withSession"),
      });
    }

    if (path.startsWith("/native/")) {
      try {
        return Response.json(await exerciseDatabase(db, path.slice(8)));
      } catch (cause) {
        return Response.json({ error: z.instanceof(Error).parse(cause).message });
      }
    }

    if (path === "/unobservable") {
      // Model a binding with unchanged public methods and unavailable internals.
      const database = observeDatabase(
        {
          prepare: db.prepare.bind(db),
          batch: db.batch.bind(db),
          exec: db.exec.bind(db),
          dump: db.dump.bind(db),
          withSession: db.withSession.bind(db),
        },
        ctx,
        async () => {
          throw new Error("Unavailable observation must not produce a measurement");
        },
      );

      return Response.json(await exerciseDatabase(database, "raw-write"));
    }

    const scope = path.startsWith("/service") ? "service" : "app";
    const identity = scope === "app" ? app : service;
    const source = z.string().parse(env["D1_CHILD_SOURCE"]);
    const sha256 = await digest(source);
    const prefix = `apps/${identity.appId}`;

    await env.WIDEFLEET_PACKAGES.put(`${prefix}/modules/${sha256}`, source);
    const modules = [{ name: "child.js", type: "esm", sha256, size: source.length }];

    const metadata = {
      main_module: "child.js",
      compatibility_date: "2026-10-01",
      bindings: [{ type: "d1", name: "DB", database_name: "fixture" }],
    };

    const nativeBindings = { DB: "NATIVE_DB" };

    const worker = env.WIDEFLEET_LOADER.get(scope, () =>
      workerCode(
        publishedApp.parse({
          id: identity.appId,
          appId: identity.appId,
          deploymentId: identity.deploymentId,
          version: identity.deploymentId,
          hostname: "observer.example.test",
          organizationId: scope === "app" ? undefined : "observer-fixture",
          metadata: {
            ...metadata,
            web: scope === "app",
            entrypoints: scope === "app" ? [] : ["default"],
            assets: { binding: "ASSETS", upload_session: identity.deploymentId },
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
