import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { activationStatus, companyProvider } from "@platform/contracts";
import { appSsoConfiguration } from "../../tools/edge-configuration.ts";
import { createCertificates } from "./certificates.ts";

const execute = promisify(execFile);

const docker = (...args: string[]) => execute("docker", args);

const snapshot = z.object({ status: activationStatus, child: z.string(), ready: z.boolean() });

describe.runIf(process.env["RUN_PACKAGED_EDGE_TESTS"] === "1")(
  "Independent app sign-in container",
  () => {
    it("applies settings, rotates secrets without restart and retains working configuration without a control plane", async () => {
      const name = `widefleet-sso-test-${randomUUID()}`;
      const volume = `${name}-state`;
      const directory = await mkdtemp(join(tmpdir(), "widefleet-rotation-"));
      const fixture = join(directory, "provider.mjs");
      await build({
        entryPoints: [fileURLToPath(new URL("rotation-provider.ts", import.meta.url))],
        outfile: fixture,
        bundle: true,
        platform: "node",
        format: "esm",
      });
      const image = process.env["PLATFORM_SSO_IMAGE"] ?? "widefleet-sso:setup-check";

      const provider = companyProvider.parse({
        type: "oidc",
        issuer: "http://127.0.0.1:4182",
        label: "Test",
      });

      const configuration = appSsoConfiguration(provider, "test-client", "/runtime/client-secret");

      const proxy = {
        ...configuration,
        providers: configuration.providers.map((entry) => ({
          ...entry,
          loginURL: "http://127.0.0.1:4182/authorize",
          redeemURL: "http://127.0.0.1:4182/token",
          oidcConfig: {
            ...entry.oidcConfig,
            skipDiscovery: true,
            jwksURL: "http://127.0.0.1:4182/jwks",
          },
        })),
      };

      const bundle = {
        revision: "first",
        proxy,
        clientSecret: "test-secret",
        cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
        domain: "apps.example.test",
        redirectUrl: "https://auth.apps.example.test/oauth2/callback",
      };

      const publish = (desired: typeof bundle) =>
        docker(
          "run",
          "--rm",
          "--network=none",
          "--volume",
          `${volume}:/auth`,
          "--entrypoint=node",
          image,
          "--input-type=module",
          "--eval",
          'import {writeFile,rename} from "node:fs/promises"; await writeFile("/auth/desired.tmp", process.argv[1], {mode:384}); await rename("/auth/desired.tmp", "/auth/desired.json");',
          JSON.stringify(desired),
        );

      const login = async () => {
        const response = await docker(
          "exec",
          name,
          "node",
          "--input-type=module",
          "--eval",
          `
          const base = "http://127.0.0.1:4180";
          const start = await fetch(base + "/oauth2/start?rd=https://notes.apps.example.test/", {redirect:"manual"});
          const cookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
          const authorized = await fetch(start.headers.get("location"), {redirect:"manual"});
          const callback = new URL(authorized.headers.get("location"));
          const result = await fetch(base + callback.pathname + callback.search, {redirect:"manual", headers:{cookie, host:"auth.apps.example.test", "x-forwarded-proto":"https"}});
          const session = result.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
          const authenticated = await fetch(base + "/oauth2/auth", {redirect:"manual", headers:{cookie:session}});
          const authorize = async (users, provider = "http://127.0.0.1:4182") => {
            const policy = Buffer.from(JSON.stringify({revision:1, groups:[], users, provider, allAuthenticated:false})).toString("base64url");
            return (await fetch("http://127.0.0.1:4181/authorize?policy=" + policy, {redirect:"manual",headers:{cookie:session}})).status;
          };
          console.log(JSON.stringify({callback:result.status, authenticated:authenticated.status,
            allowed: await authorize(["rotation-user"]), empty: await authorize([]),
            otherIssuer: await authorize(["rotation-user"], "https://other.example.test") }));
        `,
        );

        return z
          .object({
            callback: z.number(),
            authenticated: z.number(),
            allowed: z.number(),
            empty: z.number(),
            otherIssuer: z.number(),
          })
          .parse(JSON.parse(response.stdout));
      };

      const inspect = async () => {
        const result = await docker(
          "exec",
          name,
          "node",
          "--input-type=module",
          "--eval",
          'import {readFile} from "node:fs/promises"; const status=JSON.parse(await readFile("/auth/status.json","utf8")); const child=(await readFile("/proc/1/task/1/children","utf8")).trim(); let ready=false; try {ready=(await fetch("http://127.0.0.1:4180/ready",{signal:AbortSignal.timeout(500)})).ok;} catch {} console.log(JSON.stringify({status,child,ready}));',
        );

        return snapshot.parse(JSON.parse(result.stdout));
      };

      try {
        await docker("volume", "create", volume);
        await docker(
          "run",
          "-d",
          "--name",
          name,
          "--network=none",
          "--volume",
          `${volume}:/auth`,
          image,
        );
        await vi.waitFor(async () => expect((await inspect()).status.state).toBe("waiting"), {
          timeout: 15_000,
        });
        await docker("cp", fixture, `${name}:/runtime/provider.mjs`);
        await docker(
          "exec",
          "-d",
          name,
          "sh",
          "-c",
          "node /runtime/provider.mjs > /runtime/provider.log 2>&1",
        );
        await vi.waitFor(
          async () => {
            await docker(
              "exec",
              name,
              "node",
              "--eval",
              'fetch("http://127.0.0.1:4182/jwks").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))',
            );
          },
          { timeout: 15_000 },
        );
        await docker(
          "exec",
          "--user=root",
          name,
          "mv",
          "/bin/oauth2-proxy",
          "/runtime/proxy-binary",
        );
        await publish({ ...bundle, revision: "missing-executable" });
        await vi.waitFor(
          async () =>
            expect((await inspect()).status).toMatchObject({
              revision: "missing-executable",
              state: "failed",
            }),
          { timeout: 15_000 },
        );
        expect((await inspect()).status.message).toContain("executable could not be started");
        await docker(
          "exec",
          "--user=root",
          name,
          "mv",
          "/runtime/proxy-binary",
          "/bin/oauth2-proxy",
        );
        await publish({ ...bundle, revision: "first-invalid", cookieSecret: "too-short" });
        await vi.waitFor(
          async () =>
            expect((await inspect()).status).toMatchObject({
              revision: "first-invalid",
              state: "failed",
            }),
          { timeout: 15_000 },
        );
        expect((await inspect()).status.message).toContain("The SSO cookie secret is invalid.");
        expect((await inspect()).status.message).toContain("no configuration has been activated");
        expect((await inspect()).status.message).not.toContain("too-short");
        await publish(bundle);
        await vi.waitFor(
          async () =>
            expect(await inspect()).toMatchObject({
              status: { revision: "first", state: "active" },
              ready: true,
            }),
          { timeout: 15_000 },
        );
        const first = await inspect();
        expect(await login()).toEqual({
          callback: 302,
          authenticated: 202,
          allowed: 202,
          empty: 403,
          otherIssuer: 403,
        });
        await docker(
          "exec",
          name,
          "node",
          "--eval",
          'fetch("http://127.0.0.1:4182/rotate", {method:"POST",body:"rotated-secret"}).then(r=>process.exit(r.ok?0:1))',
        );
        expect((await login()).authenticated).toBe(401);
        await publish({ ...bundle, revision: "secret", clientSecret: "rotated-secret" });
        await vi.waitFor(async () => expect((await inspect()).status.revision).toBe("secret"), {
          timeout: 15_000,
        });
        expect(await inspect()).toMatchObject({
          child: first.child,
          ready: true,
          status: { state: "active" },
        });

        expect(await login()).toEqual({
          callback: 302,
          authenticated: 202,
          allowed: 202,
          empty: 403,
          otherIssuer: 403,
        });

        const replacement = {
          ...bundle,
          revision: "replacement",
          proxy: {
            ...proxy,
            providers: proxy.providers.map((entry) => ({ ...entry, clientID: "new-client" })),
          },
        };

        await publish(replacement);
        await vi.waitFor(
          async () =>
            expect(await inspect()).toMatchObject({
              status: { revision: "replacement", state: "active" },
              ready: true,
            }),
          { timeout: 15_000 },
        );
        expect((await inspect()).child).not.toBe(first.child);
        const active = await inspect();
        await publish({ ...replacement, revision: "invalid", cookieSecret: "too-short" });
        await vi.waitFor(
          async () =>
            expect((await inspect()).status).toMatchObject({
              revision: "invalid",
              state: "failed",
            }),
          { timeout: 15_000 },
        );
        expect(await inspect()).toMatchObject({ ready: true, child: active.child });
        expect((await inspect()).status.message).toContain("The SSO cookie secret is invalid.");
        expect((await inspect()).status.message).toContain(
          "The previous configuration is running.",
        );
        await publish({
          ...replacement,
          revision: "startup-failure",
          proxy: {
            ...proxy,
            providers: proxy.providers.map((entry) => ({
              ...entry,
              provider: "UnsupportedProvider",
            })),
          },
        });
        await vi.waitFor(
          async () =>
            expect(await inspect()).toMatchObject({
              ready: true,
              status: { revision: "startup-failure", state: "failed" },
            }),
          { timeout: 15_000 },
        );
        expect((await inspect()).child).not.toBe(active.child);
        expect((await inspect()).status.message).toContain(
          "The previous configuration is running.",
        );
        await docker("restart", name);
        await vi.waitFor(
          async () =>
            expect(await inspect()).toMatchObject({
              ready: true,
              status: { revision: "startup-failure", state: "failed" },
            }),
          { timeout: 15_000 },
        );
      } catch (cause) {
        const logs = await docker("logs", name);
        console.error(logs.stdout, logs.stderr);
        const providerLogs = await docker("exec", name, "cat", "/runtime/provider.log");
        console.error(providerLogs.stdout, providerLogs.stderr);
        throw cause;
      } finally {
        await docker("rm", "--force", name).catch(() => undefined);
        await docker("volume", "rm", volume);
        await rm(directory, { recursive: true, force: true });
      }
    }, 90_000);

    it("reports TLS failures and keeps the rejected revision visible through failed and successful rollback", async () => {
      const name = `widefleet-sso-errors-${randomUUID()}`;
      const directory = await mkdtemp(join(tmpdir(), "widefleet-sso-errors-"));
      const image = process.env["PLATFORM_SSO_IMAGE"] ?? "widefleet-sso:setup-check";
      const node = (...args: string[]) => docker("exec", name, "node", ...args);

      const provider = companyProvider.parse({
        type: "oidc",
        issuer: "https://localhost:4182",
        label: "Test",
      });

      const proxy = appSsoConfiguration(provider, "test-client", "/runtime/client-secret");

      const bundle = {
        revision: "untrusted",
        proxy,
        clientSecret: "fixture-client-secret",
        cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
        domain: "apps.example.test",
        redirectUrl: "https://auth.apps.example.test/oauth2/callback",
      };

      const publish = (desired: typeof bundle) =>
        node(
          "--input-type=module",
          "--eval",
          'import {writeFile,rename} from "node:fs/promises"; await writeFile("/auth/desired.tmp", process.argv[1], {mode:384}); await rename("/auth/desired.tmp", "/auth/desired.json");',
          JSON.stringify(desired),
        );

      const inspect = async () => {
        const result = await node(
          "--input-type=module",
          "--eval",
          'import {readFile} from "node:fs/promises"; const status=JSON.parse(await readFile("/auth/status.json","utf8")); let ready=false; try {ready=(await fetch("http://127.0.0.1:4180/ready",{signal:AbortSignal.timeout(500)})).ok;} catch {} console.log(JSON.stringify({status,ready,child:""}));',
        );

        return snapshot.parse(JSON.parse(result.stdout));
      };

      const startProvider = async () => {
        await docker("exec", "-d", name, "node", "/runtime/provider.mjs");
        await vi.waitFor(async () => {
          await node(
            "--input-type=module",
            "--eval",
            'import {connect} from "node:net"; const socket=connect(4182,"127.0.0.1",()=>socket.end()); socket.on("error",()=>process.exit(1));',
          );
        });
      };

      try {
        const certificates = await createCertificates(directory);
        const fixture = join(directory, "provider.mjs");
        await build({
          entryPoints: [fileURLToPath(new URL("activation-provider.ts", import.meta.url))],
          outfile: fixture,
          bundle: true,
          platform: "node",
          format: "esm",
        });
        await docker("run", "-d", "--name", name, "--network=none", image);
        await vi.waitFor(async () => expect((await inspect()).status.state).toBe("waiting"));
        await docker("cp", fixture, `${name}:/runtime/provider.mjs`);
        await docker("cp", certificates.certificate, `${name}:/runtime/server.pem`);
        await docker("cp", certificates.key, `${name}:/runtime/server.key`);
        await docker("cp", certificates.ca, `${name}:/runtime/ca.pem`);
        await docker("exec", "--user=root", name, "chown", "node:node", "/runtime/server.key");
        await startProvider();
        await publish(bundle);
        await vi.waitFor(
          async () =>
            expect(await inspect()).toMatchObject({
              ready: false,
              status: {
                revision: "untrusted",
                state: "failed",
              },
            }),
          { timeout: 15_000 },
        );
        const firstFailure = (await inspect()).status.message;
        expect(firstFailure).toContain("TLS certificate is not trusted");
        expect(firstFailure).toContain("no configuration has been activated");
        expect(firstFailure).not.toContain(bundle.clientSecret);
        expect(firstFailure).not.toContain(bundle.cookieSecret);
        expect(firstFailure).not.toContain("localhost");

        const trusted = {
          ...bundle,
          revision: "trusted",
          proxy: {
            ...proxy,
            providers: proxy.providers.map((entry) => ({ ...entry, caFiles: ["/runtime/ca.pem"] })),
          },
        };

        await publish(trusted);
        await vi.waitFor(
          async () =>
            expect(await inspect()).toMatchObject({
              ready: true,
              status: { revision: "trusted", state: "active" },
            }),
          { timeout: 15_000 },
        );
        await node(
          "--input-type=module",
          "--eval",
          'import {readFile} from "node:fs/promises"; process.kill(Number(await readFile("/runtime/provider.pid","utf8")),"SIGTERM");',
        );
        await publish({
          ...trusted,
          revision: "unreachable",
          proxy: {
            ...trusted.proxy,
            providers: trusted.proxy.providers.map((entry) => ({
              ...entry,
              clientID: "replacement-client",
            })),
          },
        });
        await vi.waitFor(
          async () =>
            expect(await inspect()).toMatchObject({
              ready: false,
              status: {
                revision: "unreachable",
                state: "failed",
              },
            }),
          { timeout: 15_000 },
        );
        expect((await inspect()).status.message).toContain(
          "identity provider could not be reached",
        );
        expect((await inspect()).status.message).toContain(
          "previous configuration is saved for retry",
        );
        // Let the retry loop run: it must not replace the failed desired revision with the active one.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect((await inspect()).status.revision).toBe("unreachable");
        await startProvider();
        await vi.waitFor(
          async () => {
            const restored = await inspect();
            expect(restored).toMatchObject({
              ready: true,
              status: {
                revision: "unreachable",
                state: "failed",
              },
            });
            expect(restored.status.message).toContain("The previous configuration is running.");
          },
          { timeout: 15_000 },
        );
      } catch (cause) {
        const logs = await docker("logs", name);
        console.error(logs.stdout, logs.stderr);
        throw cause;
      } finally {
        await docker("rm", "--force", name).catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
