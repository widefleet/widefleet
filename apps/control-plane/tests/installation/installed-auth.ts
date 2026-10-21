import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { vi, expect } from "vitest";
import { z } from "zod";
import { activationStatus, publishedApp } from "@platform/contracts";
import { authConfiguration } from "@platform/auth-proxy";
import { authControlPath } from "@platform/auth-proxy/publication";

import { companyIdentity } from "../../src/lib/server/company-identity.ts";
import { createAppSignIn } from "../../src/lib/server/app-sign-in-node.ts";
import { runtimeConfigurationSchema } from "../../src/lib/server/config.ts";

const execute = promisify(execFile);

export const docker = (...args: string[]) => execute("docker", args);

export const installedAuth = async () => {
  const name = `widefleet-auth-test-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "widefleet-auth-container-"));
  const client = `${name}-client`;
  const volume = `${name}-state`;
  const image = process.env["PLATFORM_RUNTIME_IMAGE"] ?? "widefleet-runtime:setup-check";
  const organizationId = randomUUID();
  const controlToken = `test-runtime-control-${randomUUID()}`;
  let trustedProvider = false;

  const s3 = new S3Client({
    endpoint: "http://127.0.0.1:25400",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "local-tests", secretAccessKey: "local-tests-only" },
  });

  const configuration = authConfiguration.parse({
    organizationId: "widefleet",
    provider: { type: "oidc", issuer: "http://127.0.0.1:4181", label: "Test" },
    clientId: "test-client",
    clientSecret: "test-secret",
    cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
    domain: "apps.example.test",
    redirectUrl: "https://auth.apps.example.test/oauth2/widefleet/callback",
  });

  await s3.send(new CreateBucketCommand({ Bucket: name }));
  await build({
    entryPoints: [fileURLToPath(new URL("rotation-provider.ts", import.meta.url))],
    outfile: join(directory, "provider.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });

  const node = async (script: string, ...args: string[]) =>
    (
      await docker(
        "exec",
        ...(trustedProvider ? ["--env=NODE_EXTRA_CA_CERTS=/runtime/test-ca.pem"] : []),
        client,
        "node",
        "--use-system-ca",
        "--input-type=module",
        "--eval",
        script,
        "--",
        ...args,
      )
    ).stdout.trim();

  const inspect = async () => ({
    status: activationStatus.parse(
      JSON.parse(
        await node(
          'import {readFile} from "node:fs/promises"; const key=(await readFile("/runtime-config/control-token","utf8")).trim(); const response=await fetch("http://127.0.0.1:8080' +
            "/.well-known/widefleet/auth/organizations/widefleet/configuration" +
            '",{headers:{authorization:"Bearer "+key}}); if(!response.ok)throw new Error("Auth proxy unavailable");console.log(await response.text());',
        ),
      ),
    ),
    process: (await docker("exec", name, "cat", "/proc/1/stat")).stdout.split(" ")[21],
  });

  const control = async (path: string, method: string, body?: string) =>
    z
      .number()
      .parse(
        JSON.parse(
          await node(
            'import {readFile} from "node:fs/promises"; const key=(await readFile("/runtime-config/control-token","utf8")).trim(); const response=await fetch("http://127.0.0.1:8080"+process.argv[1],{method:process.argv[2],headers:{authorization:"Bearer "+key,"content-type":"application/json"},...(process.argv[3]?{body:process.argv[3]}:{})}); console.log(response.status);',
            authControlPath + path,
            method,
            body ?? "",
          ),
        ),
      );

  const route = async (groups: string[], revision = 1) => {
    expect(
      await control(
        "/apps/notes.apps.example.test",
        "PUT",
        JSON.stringify({
          organizationId: "widefleet",
          appId: "00000000-0000-4000-8000-000000000001",
          access: { revision, groups },
        }),
      ),
    ).toBe(204);
  };

  const publish = async (input = configuration) => {
    const origin = `http://${(await docker("port", name, "8080/tcp")).stdout.trim()}`;
    await writeFile(
      join(directory, "control-token"),
      (await docker("exec", name, "cat", "/runtime-config/control-token")).stdout.trim(),
      { mode: 0o600 },
    );

    const signIn = createAppSignIn(
      {
        ...runtimeConfigurationSchema.parse({
          DATABASE_URL: "postgres://fixture:fixture@localhost/fixture",
          PLATFORM_URL: "https://platform.example.test",
          APP_DOMAIN: input.domain,
          PLATFORM_APP_RUNTIME_URL: origin,
          PLATFORM_RUNTIME_DIRECTORY: directory,
        }),
        ARTIFACT_STORAGE_PROVIDER: "s3",
      },
      input.cookieSecret,
    );

    const revision = await signIn.publish(
      companyIdentity.parse({
        provider: input.provider,
        management: {
          clientId: input.clientId,
          clientSecret: input.clientSecret,
        },
        directory: null,
      }),
      input.clientSecret,
    );

    expect(await signIn.status(revision)).toMatchObject({ revision, state: "active" });

    return revision;
  };

  const startProvider = async (tls = false) => {
    await docker("cp", join(directory, "provider.mjs"), `${client}:/runtime/provider.mjs`);
    await docker(
      "exec",
      "-d",
      ...(tls ? ["--env=OIDC_TLS_DIRECTORY=/runtime"] : []),
      client,
      "node",
      "/runtime/provider.mjs",
    );
    await vi.waitFor(
      () =>
        node(
          'import {connect} from "node:net"; const socket=connect(4181,"127.0.0.1",()=>socket.end()); socket.on("error",()=>process.exit(1));',
        ),
      { timeout: 10_000 },
    );
  };

  const startClient = () =>
    docker(
      "run",
      "-d",
      "--name",
      client,
      "--network",
      `container:${name}`,
      "--volumes-from",
      `${name}:ro`,
      "node:26.8.2-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae",
      "node",
      "--input-type=module",
      "--eval",
      'import {mkdirSync} from "node:fs"; mkdirSync("/runtime",{recursive:true}); setInterval(()=>{},1000);',
    );

  const restart = async () => {
    trustedProvider = false;
    await docker("rm", "--force", client);
    await docker("restart", "--time", "45", name);
    await startClient();
    await vi.waitFor(async () => expect((await inspect()).status.state).toBe("active"), {
      timeout: 30_000,
    });
  };

  const start = async () => {
    await docker("volume", "create", volume);
    await docker("volume", "create", `${volume}-config`);
    await docker(
      "run",
      "--rm",
      "--user=0",
      "--volume",
      `${volume}-config:/runtime-config`,
      "--entrypoint=sh",
      image,
      "-ec",
      'umask 077; printf "%s" "$1" > /runtime-config/installation.json; printf "%s" "$2" > /runtime-config/control-token; chown -R 1000:1000 /runtime-config',
      "fixture",
      JSON.stringify({ organizationId, controlToken }),
      controlToken,
    );

    const source = `export default { async fetch(request, env) {
      const url = new URL(request.url);
      return Response.json({url:url.pathname+url.search,headers:Object.fromEntries(request.headers),body:await request.text(),bindings:Object.keys(env)}, {headers:{"set-cookie":"app-cookie=blocked"}});
    }};`;

    const hash = createHash("sha256").update(source).digest("hex");

    const app = publishedApp.parse({
      id: randomUUID(),
      appId: "00000000-0000-4000-8000-000000000001",
      version: randomUUID(),
      deploymentId: randomUUID(),
      hostname: "notes.apps.example.test",
      metadata: {
        main_module: "app.js",
        compatibility_date: "2026-10-01",
        compatibility_flags: [],
        assets: { binding: "ASSETS", upload_session: randomUUID() },
        bindings: [],
        crons: [],
        queue_consumers: [],
      },
      modules: [{ name: "app.js", type: "esm", sha256: hash, size: Buffer.byteLength(source) }],
      manifest: {},
      nativeBindings: {},
      capabilities: {},
      capabilityRevision: 0,
      network: { revision: 0, policy: { backend: [], browser: [] } },
    });

    for (const [key, body] of Object.entries({
      [`apps/${app.appId}/modules/${hash}`]: source,
      [`hosts/${app.hostname}.json`]: JSON.stringify(app),
    })) {
      await s3.send(
        new PutObjectCommand({
          Bucket: name,
          Key: `organizations/${organizationId}/r2/widefleet-packages/${key}`,
          Body: body,
        }),
      );
    }

    await docker(
      "run",
      "-d",
      "--name",
      name,
      "--network=internal-app-platform-test_default",
      "--publish",
      "127.0.0.1::8080",
      "--volume",
      `${volume}-config:/runtime-config:ro`,
      "--volume",
      `${volume}:/state`,
      "--env",
      `FLEET_S3_BUCKET=${name}`,
      "--env",
      "FLEET_S3_ENDPOINT=http://rustfs:9000",
      "--env",
      "FLEET_S3_ACCESS_KEY_ID=local-tests",
      "--env",
      "FLEET_S3_SECRET_ACCESS_KEY=local-tests-only",
      image,
    );
    await startClient();
    await vi.waitFor(async () => expect((await inspect()).status.state).toBe("waiting"), {
      timeout: 30_000,
    });
  };

  const login = async () =>
    z.object({ status: z.number(), cookie: z.string(), location: z.string().nullable() }).parse(
      JSON.parse(
        await node(`
    const base="http://127.0.0.1:8080";
    const headers={"x-forwarded-host":"auth.apps.example.test","x-forwarded-proto":"https"};
    const started=await fetch(base+"/oauth2/widefleet/start?rd=https://notes.apps.example.test/",{redirect:"manual",headers});
    if(started.status!==302){console.log(JSON.stringify({status:started.status,cookie:"",location:null}));}else{
      const authorized=await fetch(started.headers.get("location"),{redirect:"manual"});
      const callback=new URL(authorized.headers.get("location"));
      const state=started.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
      const result=await fetch(base+callback.pathname+callback.search,{redirect:"manual",headers:{...headers,cookie:state}});
      console.log(JSON.stringify({status:result.status,cookie:result.headers.getSetCookie().filter(value=>!value.includes("Max-Age=0")).map(value=>value.split(";")[0]).join("; "),location:result.headers.get("location")}));
    }
  `),
      ),
    );

  const app = async (cookie: string, path = "/report") =>
    z.object({ status: z.number(), body: z.string(), cookies: z.array(z.string()) }).parse(
      JSON.parse(
        await node(
          `
    const response=await fetch("http://127.0.0.1:8080"+process.argv[2],{redirect:"manual",method:"POST",body:"app-request",headers:{"x-forwarded-host":"notes.apps.example.test","x-forwarded-proto":"https",cookie:process.argv[1],authorization:"Bearer must-not-reach-app","x-auth-request-user":"forged"}});
    console.log(JSON.stringify({status:response.status,body:await response.text(),cookies:response.headers.getSetCookie()}));
  `,
          cookie,
          path,
        ),
      ),
    );

  const dispose = async () => {
    await docker("rm", "--force", client).catch(() => undefined);
    await docker("rm", "--force", name).catch(() => undefined);
    await docker("volume", "rm", volume, `${volume}-config`).catch(() => undefined);

    for (;;) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: name }));
      const objects = (page.Contents ?? []).flatMap(({ Key }) => (Key ? [{ Key }] : []));

      if (!objects.length) break;
      await s3.send(new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: objects } }));
    }

    await s3.send(new DeleteBucketCommand({ Bucket: name }));
    s3.destroy();
    await rm(directory, { recursive: true, force: true });
  };

  return {
    name,
    client,
    trustProviderCertificate: async (certificate: string) => {
      await docker("cp", certificate, `${client}:/runtime/test-ca.pem`);
      trustedProvider = true;
    },
    restart,
    directory,
    configuration,
    start,
    startProvider,
    node,
    inspect,
    control,
    route,
    publish,
    login,
    app,
    dispose,
  };
};
