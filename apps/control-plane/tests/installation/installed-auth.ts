import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { vi, expect } from "vitest";
import { z } from "zod";
import { activationStatus, identitySettingsInput } from "@platform/contracts";
import { authConfiguration } from "@platform/auth-proxy";
import { authControlPath } from "@platform/auth-proxy/publication";

import { createAppSignIn } from "../../src/lib/server/app-sign-in-node.ts";
import { runtimeConfigurationSchema } from "../../src/lib/server/config.ts";

const execute = promisify(execFile);

export const docker = (...args: string[]) => execute("docker", args);

export const installedAuth = async () => {
  const name = `widefleet-auth-test-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "widefleet-auth-container-"));
  const client = `${name}-client`;
  const volume = `${name}-state`;
  const image = process.env["PLATFORM_SSO_IMAGE"] ?? "widefleet-sso:setup-check";
  let trustedProvider = false;

  const s3 = new S3Client({
    endpoint: "http://127.0.0.1:25400",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "local-tests", secretAccessKey: "local-tests-only" },
  });

  const configuration = authConfiguration.parse({
    provider: { type: "oidc", issuer: "http://127.0.0.1:4181", label: "Test" },
    clientId: "test-client",
    clientSecret: "test-secret",
    cookieSecret: Buffer.alloc(32, 1).toString("base64url"),
    domain: "apps.example.test",
    redirectUrl: "https://auth.apps.example.test/oauth2/callback",
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
          'import {readFile} from "node:fs/promises"; const key=(await readFile("/auth/control-token","utf8")).trim(); const response=await fetch("http://127.0.0.1:4180' +
            "/.well-known/widefleet/auth/configuration" +
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
            'import {readFile} from "node:fs/promises"; const key=(await readFile("/auth/control-token","utf8")).trim(); const response=await fetch("http://127.0.0.1:4180"+process.argv[1],{method:process.argv[2],headers:{authorization:"Bearer "+key,"content-type":"application/json"},...(process.argv[3]?{body:process.argv[3]}:{})}); console.log(response.status);',
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
          appId: "00000000-0000-4000-8000-000000000001",
          access: { revision, groups },
          upstream: "http://127.0.0.1:4183",
        }),
      ),
    ).toBe(204);
  };

  const publish = async (input = configuration) => {
    const origin = `http://${(await docker("port", name, "4180/tcp")).stdout.trim()}`;
    await writeFile(
      join(directory, "control-token"),
      (await docker("exec", name, "cat", "/auth/control-token")).stdout.trim(),
      { mode: 0o600 },
    );

    const signIn = createAppSignIn(
      {
        ...runtimeConfigurationSchema.parse({
          DATABASE_URL: "postgres://fixture:fixture@localhost/fixture",
          PLATFORM_URL: "https://platform.example.test",
          APP_DOMAIN: input.domain,
          PLATFORM_APP_AUTH_URL: origin,
          PLATFORM_AUTH_DIRECTORY: directory,
        }),
        ARTIFACT_STORAGE_PROVIDER: "s3",
      },
      input.cookieSecret,
    );

    const revision = await signIn.publish(
      identitySettingsInput.parse({
        provider: input.provider,
        management: {
          clientId: input.clientId,
          secret: { type: "value", value: input.clientSecret },
        },
        apps: { clientId: input.clientId, secret: { type: "value", value: input.clientSecret } },
        directory: null,
      }),
      input.clientSecret,
      true,
    );

    expect(await signIn.status()).toMatchObject({ revision, state: "active" });

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
    await docker(
      "run",
      "-d",
      "--name",
      name,
      "--network=internal-app-platform-test_default",
      "--publish",
      "127.0.0.1::4180",
      "--volume",
      `${volume}:/auth`,
      "--env",
      `CELLD_BUCKET=s3://${name}/auth-proxy`,
      "--env",
      "S3_ENDPOINT=http://rustfs:9000",
      "--env",
      "AWS_REGION=us-east-1",
      "--env",
      "AWS_ACCESS_KEY_ID=local-tests",
      "--env",
      "AWS_SECRET_ACCESS_KEY=local-tests-only",
      image,
    );
    await startClient();
    await vi.waitFor(async () => expect((await inspect()).status.state).toBe("waiting"), {
      timeout: 30_000,
    });
    await docker(
      "exec",
      "-d",
      client,
      "node",
      "--input-type=module",
      "--eval",
      'import {createServer} from "node:http"; createServer(async (request,response)=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);response.setHeader("content-type","application/json");response.setHeader("set-cookie","app-cookie=blocked");response.end(JSON.stringify({url:request.url,headers:request.headers,body:Buffer.concat(chunks).toString()}));}).listen(4183,"0.0.0.0");',
    );
    await vi.waitFor(() => node('await fetch("http://127.0.0.1:4183");'), { timeout: 10_000 });
  };

  const login = async () =>
    z.object({ status: z.number(), cookie: z.string(), location: z.string().nullable() }).parse(
      JSON.parse(
        await node(`
    const base="http://127.0.0.1:4180";
    const headers={"x-forwarded-host":"auth.apps.example.test","x-forwarded-proto":"https"};
    const started=await fetch(base+"/oauth2/start?rd=https://notes.apps.example.test/",{redirect:"manual",headers});
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
    const response=await fetch("http://127.0.0.1:4180"+process.argv[2],{redirect:"manual",method:"POST",body:"app-request",headers:{"x-forwarded-host":"notes.apps.example.test","x-forwarded-proto":"https",cookie:process.argv[1],authorization:"Bearer must-not-reach-app","x-auth-request-user":"forged"}});
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
    await docker("volume", "rm", volume).catch(() => undefined);

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
