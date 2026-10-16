import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { installedAuth, docker } from "./installed-auth.ts";

describe.runIf(process.env["RUN_PACKAGED_EDGE_TESTS"] === "1")("Installed auth proxy", () => {
  it("forwards verified identities, applies configuration without restarting, and survives loss of the control plane", async () => {
    const fixture = await installedAuth();

    try {
      await fixture.start();
      await fixture.startProvider();
      await fixture.publish();
      await fixture.route([]);
      const original = await fixture.inspect();
      const login = await fixture.login();
      expect(login.status).toBe(302);
      expect(login.location).toBe("https://notes.apps.example.test/");
      const app = await fixture.app(login.cookie);
      expect(app.status).toBe(200);
      expect(app.cookies).toEqual([]);

      const echoed = z
        .object({ headers: z.record(z.string(), z.string()), body: z.string() })
        .parse(JSON.parse(app.body));

      expect(echoed.body).toBe("app-request");
      expect(echoed.headers["x-auth-request-user"]).toBe("rotation-user");
      expect(echoed.headers["x-auth-request-email"]).toBe("rotation@example.test");
      expect(echoed.headers["x-forwarded-host"]).toBe("notes.apps.example.test");
      expect(echoed.headers["x-forwarded-proto"]).toBe("https");
      expect(echoed.headers).not.toHaveProperty("cookie");
      expect(echoed.headers).not.toHaveProperty("authorization");
      const repeatedSlash = await fixture.app(login.cookie, "//unrelated.invalid/report?value=1");
      expect(repeatedSlash.status).toBe(200);
      expect(JSON.parse(repeatedSlash.body)).toMatchObject({
        url: "//unrelated.invalid/report?value=1",
      });
      await fixture.route(["administrators"], 2);
      expect((await fixture.app(login.cookie)).status).toBe(403);
      await fixture.route([], 3);
      await fixture.node(
        'await fetch("http://127.0.0.1:4181/rotate",{method:"POST",body:"rotated-secret"});',
      );
      await fixture.publish({ ...fixture.configuration, clientSecret: "rotated-secret" });
      expect((await fixture.inspect()).process).toBe(original.process);
      expect((await fixture.login()).location).toBe("https://notes.apps.example.test/");
      expect((await fixture.app(login.cookie)).status).toBe(200);
      expect((await docker("exec", fixture.name, "cat", "/proc/1/comm")).stdout.trim()).toBe(
        "celld",
      );
      await expect(docker("exec", fixture.name, "sh", "-c", "command -v node")).rejects.toThrow();
      await expect(
        docker("exec", fixture.name, "test", "-e", "/auth/desired.json"),
      ).rejects.toThrow();
      await fixture.restart();
      // Restart only the synthetic upstream; neither an identity provider nor management is running.
      await docker(
        "exec",
        "-d",
        fixture.client,
        "node",
        "--input-type=module",
        "--eval",
        'import {createServer} from "node:http";createServer((request,response)=>response.end("still-running")).listen(4183,"127.0.0.1");',
      );
      await vi.waitFor(async () => expect((await fixture.app(login.cookie)).status).toBe(200), {
        timeout: 10_000,
      });
      expect(await fixture.control("/apps/notes.apps.example.test", "DELETE")).toBe(204);
      expect((await fixture.app(login.cookie)).status).toBe(404);
    } finally {
      await fixture.dispose();
    }
  }, 120_000);
});
