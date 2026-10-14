import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createTestEnvironment } from "./environment.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import {
  CloudflareBindingUpdatePending,
  updateCloudflareBindings,
} from "../src/lib/server/cloudflare-binding-updates.ts";
import {
  cloudflareResource,
  createCloudflareProvisioner,
} from "../src/lib/server/cloudflare-provisioning.ts";
import { cloudflareRuntimeBindings } from "../src/lib/server/schema.ts";

const binding = z.object({
  name: z.string(),
  type: z.string(),
  id: z.string().optional(),
  database_id: z.string().optional(),
  bucket_name: z.string().optional(),
});

const fixture = () => {
  const settings = new Map<string, z.infer<typeof binding>>([
    ["SECRET", { name: "SECRET", type: "secret_text" }],
    ["EXISTING", { name: "EXISTING", type: "d1", database_id: "existing-database" }],
  ]);

  let tag = "original";
  let next = "normal";
  const sent: string[] = [];
  const held: (() => void)[] = [];

  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);

    const ok = () =>
      Response.json({
        success: true,
        result: { bindings: [...settings.values()], annotations: { "workers/tag": tag } },
      });

    if (request.method === "GET") return ok();
    const data = await request.formData();

    const update = z
      .object({
        annotations: z.object({ "workers/tag": z.uuid() }),
        bindings: z.array(binding),
      })
      .parse(JSON.parse(z.string().parse(data.get("settings"))));

    sent.push(update.annotations["workers/tag"]);
    const mode = next;
    next = "normal";

    if (mode === "rejected") return new Response(null, { status: 403 });

    const apply = () => {
      const retained = update.bindings.map((item) => {
        const value = item.type === "inherit" ? settings.get(item.name) : item;

        if (!value) throw new Error("Unknown inherited binding");

        return [item.name, value] as const;
      });

      settings.clear();

      for (const [name, value] of retained) settings.set(name, value);
      tag = update.annotations["workers/tag"];
    };

    if (mode === "delayed" || mode === "server-error") {
      held.push(apply);

      if (mode === "server-error") return new Response(null, { status: 503 });
      throw new DOMException("Fixture connection timed out", "TimeoutError");
    }

    apply();

    if (mode === "lost-response") throw new Error("Fixture lost response");

    if (mode === "held-response") {
      return new Promise<Response>((resolve) => {
        held.push(() => resolve(ok()));
      });
    }

    return ok();
  };

  const create = (runtimeName = "fixture") =>
    createCloudflareProvisioner(
      { accountId: "0".repeat(32), runtimeName, token: "fixture" },
      transport,
    );

  return {
    create,
    settings,
    sent,
    held,
    next: (mode: string) => {
      next = mode;
    },
    changeTag: () => {
      tag = "unrelated-update";
    },
    release: () => {
      const apply = held.shift();

      if (!apply) throw new Error("No held request");
      apply();
    },
  };
};

const resource = (name: string) =>
  cloudflareResource.parse({ type: "r2_bucket", name, bucket_name: name });

describe("Durable Cloudflare binding updates", () => {
  let environment: Awaited<ReturnType<typeof createTestEnvironment>>;
  beforeAll(async () => {
    environment = await createTestEnvironment();
  });
  beforeEach(async () => {
    await environment.database.db.delete(cloudflareRuntimeBindings);
  });
  afterAll(async () => {
    await environment.close();
  });

  const state = async (scope: string) => {
    const [record] = await environment.database.db
      .select()
      .from(cloudflareRuntimeBindings)
      .where(eq(cloudflareRuntimeBindings.scope, scope));

    return record?.pending;
  };

  it("preserves concurrent additions and avoids writes for existing bindings", async () => {
    const cloud = fixture();
    const resources = ["A", "B", "C"].map(resource);

    const outcomes = await Promise.allSettled(
      resources.map((item) =>
        updateCloudflareBindings(environment.database.db, cloud.create(), [item]),
      ),
    );

    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        expect(outcome.reason).toBeInstanceOf(CloudflareBindingUpdatePending);

    for (const item of resources)
      await updateCloudflareBindings(environment.database.db, cloud.create(), [item]);
    expect(cloud.sent).toHaveLength(3);
    expect([...cloud.settings.keys()].sort()).toEqual(["A", "B", "C", "EXISTING", "SECRET"]);
    await updateCloudflareBindings(environment.database.db, cloud.create(), resources);
    await updateCloudflareBindings(environment.database.db, cloud.create(), [
      { type: "d1", name: "EXISTING", id: "existing-database" },
    ]);
    expect(cloud.sent).toHaveLength(3);
    expect(await state(cloud.create().scope)).toBeNull();
  });

  it("keeps a delayed write fenced across fresh database connections and resumes from its marker", async () => {
    const cloud = fixture();
    cloud.next("delayed");
    const first = createDatabase(environment.configuration);

    try {
      await expect(
        updateCloudflareBindings(first.db, cloud.create(), [resource("A")]),
      ).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
    } finally {
      await first.close();
    }

    const pending = await state(cloud.create().scope);
    expect(pending).toMatchObject({ id: cloud.sent[0], bindings: ["SECRET", "EXISTING", "A"] });
    const second = createDatabase(environment.configuration);

    try {
      for (const name of ["A", "B", "B"])
        await expect(
          updateCloudflareBindings(second.db, cloud.create(), [resource(name)]),
        ).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
      // A normal code deployment still works with resources retained by the outstanding write.
      await updateCloudflareBindings(second.db, cloud.create(), [
        { type: "d1", name: "EXISTING", id: "existing-database" },
      ]);
      await updateCloudflareBindings(second.db, cloud.create(), []);
      expect(await state(cloud.create().scope)).toEqual(pending);
      expect(cloud.sent).toHaveLength(1);
      cloud.release();
      await updateCloudflareBindings(second.db, cloud.create(), [resource("B")]);
      expect(cloud.sent).toHaveLength(2);
      expect([...cloud.settings.keys()].sort()).toEqual(["A", "B", "EXISTING", "SECRET"]);
      expect(await state(cloud.create().scope)).toBeNull();
    } finally {
      await second.close();
    }
  });

  it("confirms a lost response without sending the mutation again", async () => {
    const cloud = fixture();
    cloud.next("lost-response");
    await expect(
      updateCloudflareBindings(environment.database.db, cloud.create(), [resource("A")]),
    ).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
    expect(await state(cloud.create().scope)).toMatchObject({ id: cloud.sent[0] });
    await updateCloudflareBindings(environment.database.db, cloud.create(), [resource("A")]);
    expect(cloud.sent).toHaveLength(1);
    expect(await state(cloud.create().scope)).toBeNull();
  });

  it("does not let an older acknowledgement clear a newer outstanding mutation", async () => {
    const cloud = fixture();
    cloud.next("held-response");

    const first = updateCloudflareBindings(environment.database.db, cloud.create(), [
      resource("A"),
    ]);

    await expect.poll(() => cloud.held.length).toBe(1);
    cloud.next("delayed");
    await expect(
      updateCloudflareBindings(environment.database.db, cloud.create(), [resource("B")]),
    ).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
    cloud.release();
    await first;
    expect(await state(cloud.create().scope)).toMatchObject({ id: cloud.sent[1] });
    cloud.release();
    await updateCloudflareBindings(environment.database.db, cloud.create(), [resource("B")]);
    expect(cloud.sent).toHaveLength(2);
    expect(await state(cloud.create().scope)).toBeNull();
  });

  it("releases explicit rejections but retains ambiguous server failures", async () => {
    const cloud = fixture();
    cloud.next("rejected");
    await expect(
      updateCloudflareBindings(environment.database.db, cloud.create(), [resource("A")]),
    ).rejects.toThrow("HTTP 403");
    expect(await state(cloud.create().scope)).toBeNull();
    cloud.next("server-error");
    await expect(
      updateCloudflareBindings(environment.database.db, cloud.create(), [resource("A")]),
    ).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
    await expect(
      updateCloudflareBindings(environment.database.db, cloud.create(), [resource("B")]),
    ).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
    expect(cloud.sent).toHaveLength(2);
    cloud.release();
    await updateCloudflareBindings(environment.database.db, cloud.create(), [resource("B")]);
    expect(cloud.sent).toHaveLength(3);
  });

  it("does not infer completion from age, different markers, or matching resource names", async () => {
    const cloud = fixture();
    cloud.next("lost-response");
    await expect(
      updateCloudflareBindings(environment.database.db, cloud.create(), [resource("A")]),
    ).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
    cloud.changeTag();
    await environment.database.db
      .update(cloudflareRuntimeBindings)
      .set({
        pending: {
          id: cloud.sent[0],
          bindings: ["SECRET", "EXISTING", "A"],
          createdAt: "2000-01-01T00:00:00.000Z",
        },
      })
      .where(eq(cloudflareRuntimeBindings.scope, cloud.create().scope));
    await expect(
      updateCloudflareBindings(environment.database.db, cloud.create(), [resource("B")]),
    ).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
    expect(cloud.sent).toHaveLength(1);
    // The guard is specific to the affected runtime, not a global installation scheduler.
    const independent = fixture();
    await updateCloudflareBindings(environment.database.db, independent.create("independent"), [
      resource("C"),
    ]);
    expect(cloud.sent).toHaveLength(1);
    expect(independent.sent).toHaveLength(1);
    expect(await state(cloud.create().scope)).toMatchObject({ id: cloud.sent[0] });
  });

  it("does not overwrite a binding that points at another resource", async () => {
    const cloud = fixture();
    await expect(
      updateCloudflareBindings(environment.database.db, cloud.create(), [resource("EXISTING")]),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(cloud.sent).toHaveLength(0);
  });
  it("detaches only the selected resources and confirms a lost removal response before another mutation", async () => {
    const api = fixture();
    const provisioner = api.create();
    await updateCloudflareBindings(environment.database.db, provisioner, [
      resource("OWN"),
      resource("OTHER"),
    ]);
    api.next("lost-response");
    await expect(
      updateCloudflareBindings(environment.database.db, provisioner, [], ["OWN"]),
    ).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
    expect(api.settings.has("OWN")).toBe(false);
    await updateCloudflareBindings(environment.database.db, provisioner, [], ["OWN"]);
    expect([...api.settings.keys()]).toEqual(["SECRET", "EXISTING", "OTHER"]);
    expect(api.sent).toHaveLength(2);
    expect(await state(provisioner.scope)).toBeNull();
  });

  it("does not treat an absent binding as removed while an older write can still add it", async () => {
    const api = fixture();
    const provisioner = api.create();
    api.next("delayed");
    await expect(
      updateCloudflareBindings(environment.database.db, provisioner, [resource("OWN")]),
    ).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
    await expect(
      updateCloudflareBindings(environment.database.db, provisioner, [], ["OWN"]),
    ).rejects.toBeInstanceOf(CloudflareBindingUpdatePending);
    expect(api.sent).toHaveLength(1);
    api.release();
    await updateCloudflareBindings(environment.database.db, provisioner, [], ["OWN"]);
    expect([...api.settings.keys()]).toEqual(["SECRET", "EXISTING"]);
    expect(api.sent).toHaveLength(2);
  });
});
