import { createProvider } from "@platform/connector-oauth-prototype/fixture-provider";
import { authConfiguration } from "@platform/auth-proxy";
import * as contract from "@platform/contracts";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { build } from "esbuild";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, request as upstreamRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { apiResource } from "../../src/lib/server/auth-options.ts";
import { createTestEnvironment } from "../environment.ts";
import { createIdentityProvider } from "../edge/auth-proxy-idp.ts";

// Uses only the repository's synthetic PostgreSQL/S3 fixtures. Apps, connector,
// secrets and grants are published by the normal CLI and processed by the agent.
const execute = promisify(execFile);

const root = fileURLToPath(new URL("../../../../", import.meta.url));

const hostname = process.argv[2] ?? "127.0.0.1";

const address = (await lookup(hostname, { family: 4 })).address;

const domain = `${address.replaceAll(".", "-")}.sslip.io`;

const httpsPort = 25553;

const managementPort = 25530;

const serverPort = 25531;

const management = `http://localhost:${managementPort}`;

const authOrigin = `https://auth.${domain}:${httpsPort}`;

const connectorPath = "/_widefleet/connectors/GITHUB";

const state = await mkdtemp(join(tmpdir(), "widefleet-connector-oauth-"));

const runtimeName = `widefleet-oauth-${randomBytes(5).toString("hex")}`;

const runtimeToken = randomBytes(32).toString("base64url");

const environment = await createTestEnvironment(management);

environment.configuration.APP_DOMAIN = domain;

environment.configuration.APP_HTTPS_PORT = httpsPort;

environment.environment.APP_DOMAIN = domain;

const bucket = runtimeName;

environment.configuration.S3_BUCKET = bucket;

environment.environment.S3_BUCKET = bucket;

const organizationId = "widefleet";

const s3 = new S3Client({
  endpoint: "http://127.0.0.1:25400",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "local-tests", secretAccessKey: "local-tests-only" },
});

await s3.send(new CreateBucketCommand({ Bucket: bucket }));

const person = environment.users.createUser({
  name: "Connector test administrator",
  email: "connector@example.test",
});

await environment.users.saveUser(person);

await environment.linkMicrosoftUser(person.id, z.uuid().parse(environment.ownerSubject));

const now = Math.floor(Date.now() / 1000);

const accessToken = (
  await environment.auth.api.signJWT({
    body: {
      payload: {
        sub: person.id,
        reference_id: `user:${person.id}`,
        aud: apiResource(environment.configuration),
        iss: `${management}/api/auth`,
        iat: now,
        exp: now + 86400,
        scope: "platform:read platform:write network:manage",
      },
    },
  })
).token;

const proxy = createServer((incoming, outgoing) => {
  const upstream = upstreamRequest(
    {
      hostname: "127.0.0.1",
      port: serverPort,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, "x-forwarded-proto": "http" },
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );

  upstream.on("error", () => outgoing.writeHead(502).end());
  incoming.pipe(upstream);
});

proxy.listen(managementPort, "127.0.0.1");

await once(proxy, "listening");

await mkdir(join(state, organizationId));

await writeFile(
  join(state, "installation.json"),
  JSON.stringify({ organizationId, controlToken: runtimeToken }),
);

await writeFile(join(state, "auth-key"), runtimeToken);

await writeFile(
  join(environment.environment.PLATFORM_RUNTIME_DIRECTORY, "control-token"),
  runtimeToken,
);

const runtimeNetwork = `platform-execution-${organizationId}`;

await execute("docker", ["network", "inspect", runtimeNetwork]).catch(() =>
  execute("docker", ["network", "create", runtimeNetwork]),
);

await execute("docker", [
  "network",
  "connect",
  runtimeNetwork,
  "internal-app-platform-test-rustfs-1",
]).catch(() => undefined);

await execute("docker", [
  "run",
  "-d",
  "--name",
  runtimeName,
  "--user=0",
  "--network",
  runtimeNetwork,
  "--publish",
  "127.0.0.1::8080",
  "--volume",
  `${state}/${organizationId}:/state`,
  "--volume",
  `${state}:/agent-state:ro`,
  "--volume",
  `${state}/installation.json:/runtime-config/installation.json:ro`,
  "--volume",
  `${root}/packages/app-runtime/dist/release.json:/opt/widefleet-runtime/release.json:ro`,
  "--env",
  "FLEET_S3_ENDPOINT=http://internal-app-platform-test-rustfs-1:9000",
  "--env",
  `FLEET_S3_BUCKET=${bucket}`,
  "--env",
  "FLEET_S3_ACCESS_KEY_ID=local-tests",
  "--env",
  "FLEET_S3_SECRET_ACCESS_KEY=local-tests-only",
  "app-platform-runtime:0.1.0",
]);

const runtimeOrigin = `http://${(await execute("docker", ["port", runtimeName, "8080/tcp"])).stdout.trim()}`;

const waitFor = async (url: string, headers?: HeadersInit) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url, { headers: headers ?? {} })).ok) return;
    } catch {
      /* Startup may still be in progress. */
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Service did not become ready: ${url}`);
};

await waitFor(`${runtimeOrigin}/.well-known/widefleet/runtime`, {
  authorization: `Bearer ${runtimeToken}`,
});

const company = await createIdentityProvider(`${authOrigin}/oauth2/widefleet/callback`, true, {
  hostname,
});

const companyPort = new URL(company.origin).port;

// Discovery uses a loopback issuer accepted by the unchanged SSO validation.
// This fixture relay makes that issuer reachable inside the runtime namespace.
await execute("docker", [
  "run",
  "-d",
  "--name",
  `${runtimeName}-idp`,
  "--network",
  `container:${runtimeName}`,
  "--entrypoint",
  "node",
  "app-platform-control-plane:0.1.0",
  "--input-type=module",
  "-e",
  `import net from 'node:net'; net.createServer(client=>{const upstream=net.connect(${companyPort},${JSON.stringify(address)});client.pipe(upstream).pipe(client);upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());}).listen(${companyPort},'127.0.0.1');`,
]);

const identity = authConfiguration.parse({
  organizationId,
  provider: {
    type: "oidc",
    issuer: company.origin,
    label: "Local company",
    nameClaim: "display_name",
    emailClaim: "mail",
    groupsClaim: "roles",
  },
  clientId: "app-login",
  clientSecret: "synthetic-client-secret",
  cookieSecret: randomBytes(32).toString("base64url"),
  domain,
  redirectUrl: `${authOrigin}/oauth2/widefleet/callback`,
});

const configured = await fetch(
  `${runtimeOrigin}/.well-known/widefleet/auth/organizations/${organizationId}/configuration`,
  {
    method: "PUT",
    headers: { authorization: `Bearer ${runtimeToken}` },
    body: JSON.stringify(identity),
  },
);

if (configured.status !== 204) throw new Error(await configured.text());

const server = spawn(process.execPath, ["build"], {
  cwd: join(root, "apps/control-plane"),
  env: {
    ...process.env,
    ...environment.environment,
    APP_HTTPS_PORT: String(httpsPort),
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(serverPort),
    PROTOCOL_HEADER: "x-forwarded-proto",
    BODY_SIZE_LIMIT: "100M",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

server.stdout.on("data", (data: Buffer) => {
  void writeFile(join(state, "control-plane.log"), data, { flag: "a" });
});

server.stderr.on("data", (data: Buffer) => {
  void writeFile(join(state, "control-plane.log"), data, { flag: "a" });
});

await waitFor(`${management}/healthz`);

const api = async (path: string, method: "POST", body: Record<string, string>) => {
  const response = await fetch(`${management}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      origin: management,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);

  return z.json().parse(await response.json());
};

const registration = z
  .object({ token: z.string() })
  .parse(await api("/agents", "POST", { name: "Connector OAuth local agent" }));

const dockerHost = (
  await execute("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
).stdout.trim();

const agent = async () => {
  const result = await execute(join(root, "target/debug/platform-agent"), ["--once"], {
    cwd: root,
    timeout: 120000,
    env: {
      ...process.env,
      DOCKER_HOST: dockerHost,
      PLATFORM_URL: management,
      PLATFORM_AGENT_TOKEN: registration.token,
      PLATFORM_AGENT_STATE: state,
      PLATFORM_RUNTIME_CONTAINER: runtimeName,
      PLATFORM_ROUTING_DIRECTORY: join(state, "routes"),
      APP_DOMAIN: domain,
      TLS_MODE: "cloudflare",
      CELLD_BINARY: join(root, ".tools/celld"),
      PLATFORM_APP_RUNTIME_URL: runtimeOrigin,
      PLATFORM_RUNTIME_KEY_FILE: join(state, "auth-key"),
      FLEET_S3_ENDPOINT: "http://127.0.0.1:25400",
      FLEET_RUNTIME_S3_ENDPOINT: "http://internal-app-platform-test-rustfs-1:9000",
      FLEET_S3_BUCKET: bucket,
      FLEET_S3_ACCESS_KEY_ID: "local-tests",
      FLEET_S3_SECRET_ACCESS_KEY: "local-tests-only",
      PLATFORM_RUNTIME_PLATFORM_URL: "http://telemetry.invalid",
    },
    maxBuffer: 8 * 1024 * 1024,
  });

  await writeFile(join(state, "agent.log"), result.stdout + result.stderr, { flag: "a" });
};

const packaged = (
  await execute(
    process.execPath,
    ["tools/package-cli.ts", "--binary", "target/debug/widefleet", "--output", join(state, "cli")],
    { cwd: root },
  )
).stdout.trim();

await mkdir(join(state, "installed"));

await execute("tar", ["-xzf", packaged, "-C", join(state, "installed"), "--strip-components=1"]);

const cli = (...args: string[]) =>
  execute(join(state, "installed/widefleet"), args, {
    cwd: state,
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PLATFORM_URL: management, PLATFORM_ACCESS_TOKEN: accessToken },
  });

const apps = [];

for (const slug of ["issues", "dashboard"]) {
  apps.push(
    contract.app.parse(
      await api("/apps", "POST", {
        slug,
        displayName: slug === "issues" ? "GitHub Issues" : "GitHub Dashboard",
      }),
    ),
  );
}

const origins = apps.map((app) => `https://${app.hostname}:${httpsPort}`);

const canonical = z.string().parse(origins[0]);

const github = await createProvider(hostname);

github.setCallbackURL(`${canonical}${connectorPath}/auth/callback/github`);

const connector = join(state, "connector");

await mkdir(connector);

await build({
  entryPoints: [fileURLToPath(import.meta.resolve("@platform/connector-oauth-prototype"))],
  outfile: join(connector, "worker.js"),
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2023",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
  loader: { ".sql": "text" },
});

const connectorConfig = join(connector, "wrangler.jsonc");

await writeFile(
  connectorConfig,
  JSON.stringify({
    name: "github",
    main: "worker.js",
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    browser_entrypoints: ["default"],
    d1_databases: [{ binding: "DB", database_name: "github-oauth", database_id: "local" }],
    vars: {
      CONNECTOR_ORIGIN: canonical,
      CONNECTOR_BASE_PATH: connectorPath,
      APP_ORIGINS: origins.join(" "),
      PROVIDER_ORIGIN: github.origin,
      PROVIDER_API_ORIGIN: github.origin,
      GITHUB_CLIENT_ID: "local-github-client",
      GITHUB_SCOPES: "read:user",
    },
  }),
);

console.info("Publishing GitHub connector through CLI and agent…");

await cli("connector", "deploy", "--config", connectorConfig, "--no-wait");

await agent();

for (const [name, value] of Object.entries({
  AUTH_SECRET: randomBytes(32).toString("base64url"),
  GITHUB_CLIENT_SECRET: "local-github-secret",
})) {
  const file = join(state, `${name}.txt`);
  await writeFile(file, value, { mode: 0o600 });
  await cli("connector", "secret", "put", "github", name, "--file", file, "--no-wait");
  await agent();
}

for (const [index, app] of apps.entries()) {
  const directory = join(state, app.slug);
  await mkdir(join(directory, "public"), { recursive: true });
  const other = origins[index === 0 ? 1 : 0];
  await writeFile(
    join(directory, "worker.js"),
    `const escape = value => String(value).replace(/[&<>"']/g, c => '&#'+c.charCodeAt(0)+';');
export default { async fetch(request, env) {
  const url = new URL(request.url);
  const status = await env.GITHUB.connectionStatus();
  const result = await env.GITHUB.listIssues();
  const user = request.headers.get('x-auth-request-preferred-username');
  if (url.pathname === '/api/issues') return Response.json({user, ...status, ...result});
  const connect = ${JSON.stringify(`${canonical}${connectorPath}/`)} + '?returnTo=' + encodeURIComponent(url.origin+'/');
  return new Response('<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${app.displayName}</title><style>body{font:17px system-ui;max-width:760px;margin:60px auto;padding:24px;color:#242424;background:#fafafa}nav{display:flex;gap:24px;margin-bottom:48px}a{color:#4341b8}section{background:white;border:1px solid #ddd;border-radius:12px;padding:24px;margin:24px 0}small{color:#666}li{padding:12px 0}</style><nav><a href="${other}">Andere App öffnen</a><a href="'+escape(url.origin)+'/api/issues">API-Ergebnis</a></nav><small>In Widefleet veröffentlichte App</small><h1>${app.displayName}</h1><p>Angemeldet als <strong>'+escape(user)+'</strong></p><section><h2>Deine GitHub-Verbindung</h2><p>'+escape(status.status === 'connected' ? 'Verbunden: Konto '+status.githubAccountId : 'Noch nicht verbunden')+'</p><a href="'+escape(connect)+'">'+(status.status === 'connected' ? 'Verbindung verwalten' : 'GitHub verbinden')+'</a></section><section><h2>${index === 0 ? "Deine Issues" : "Übersicht"}</h2><ul>'+result.issues.map(issue => '<li>'+escape(issue.title)+'</li>').join('')+'</ul>'+(result.status === 'connected' ? '' : '<p>Verbinde GitHub, um deine Issues zu sehen.</p>')+'</section><small>Firmenanmeldung und GitHub werden lokal simuliert. Diese App läuft in Widefleet und verwendet den veröffentlichten Connector.</small></html>', {headers:{'content-type':'text/html; charset=utf-8', 'cache-control':'no-store'}});
} };`,
  );
  const config = join(directory, "wrangler.jsonc");
  await writeFile(
    config,
    JSON.stringify({
      name: app.slug,
      main: "worker.js",
      compatibility_date: "2026-10-01",
      assets: { directory: "public", binding: "ASSETS" },
    }),
  );
  await cli("deploy", app.id, "--config", config, "--skip-build", "--no-wait");
  await agent();
  await cli("connector", "bind", "github", "--as", "GITHUB", "--app", app.slug, "--no-wait");
  await agent();
}

await execute("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-days",
  "3",
  "-keyout",
  join(state, "tls.key"),
  "-out",
  join(state, "tls.crt"),
  "-subj",
  "/CN=Widefleet local OAuth",
  "-addext",
  `subjectAltName=DNS:*.${domain},DNS:${hostname}`,
]);

const edge = createHttpsServer(
  { key: await readFile(join(state, "tls.key")), cert: await readFile(join(state, "tls.crt")) },
  (incoming, outgoing) => {
    const upstream = upstreamRequest(
      new URL(incoming.url ?? "/", runtimeOrigin),
      { method: incoming.method, headers: { ...incoming.headers, "x-forwarded-proto": "https" } },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );

    upstream.on("error", () => outgoing.writeHead(502).end());
    incoming.pipe(upstream);
  },
);

edge.listen(httpsPort, address);

await once(edge, "listening");

await writeFile(
  join(state, "demo.json"),
  JSON.stringify(
    {
      origins,
      authOrigin,
      runtimeName,
      runtimeOrigin,
      management,
      state,
      company: company.origin,
      github: github.origin,
      connectorConfig,
    },
    null,
    2,
  ),
);

console.info(JSON.stringify({ apps: origins, state, runtimeName }, null, 2));

console.info(
  "Published through Widefleet. Local TLS certificate; only synthetic identities and provider data. Ctrl+C stops the servers; the local deployment state is retained.",
);

process.once("SIGINT", () => {
  void (async () => {
    server.kill("SIGTERM");
    edge.close();
    proxy.close();
    await Promise.all([
      company.stop(),
      github.close(),
      execute("docker", ["rm", "-f", `${runtimeName}-idp`, runtimeName]),
    ]);
    s3.destroy();
    await environment.close();
    process.exit(0);
  })();
});
