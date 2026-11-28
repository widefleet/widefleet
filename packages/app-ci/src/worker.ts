// Builds and deploys commits from Widefleet Git in a Linux container, as on a
// computer: install the locked dependencies, then run `widefleet deploy`.
// Credentials stay in this Worker. The container reaches only the npm registry,
// reads of its app's repository and the control plane calls of `widefleet
// deploy` for its app, which the Outbound entrypoint authorizes. Only the
// control plane reaches the CI, through a service binding to `AppCi`.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { sourceCredential } from "@platform/contracts";
import { ciBuildRequest, ciBuildResult } from "@platform/contracts/builds";
import { z } from "zod";

const registry = "registry.npmjs.org";

const source = "/build/source";

// Intercepted HTTPS is signed with the Containers CA. Commands do not inherit
// the environment of start(), so each command receives it.
const certificates = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

// The log keeps the end of the output, where failures are reported.
const logLimit = 256 * 1024;

// Stops a container whose build call was lost.
const inactivityTimeout = 15 * 60 * 1000;

// The log of an outcome nobody released is dropped after this.
const logLifetime = 24 * 60 * 60 * 1000;

const instant = z.number().nonnegative();

interface Env {
  BUILDS: DurableObjectNamespace<BuildSandbox>;
}

interface OutboundProps {
  appId: string;
  build: string;
  repository: string;
  platform: { origin: string; organizationId: string; authorization: string };
}

interface BuildSandboxState extends DurableObjectState {
  readonly exports: { Outbound: (options: { props: OutboundProps }) => Fetcher };
}

const denied = (request: Request) =>
  new Response(`Builds cannot reach ${request.method} ${new URL(request.url).origin}\n`, {
    status: 403,
  });

/**
 * The repository requests of a clone, a fetch and the up-to-date check of the
 * source push of `widefleet deploy`. Builds cannot write to the repository.
 */
const repositoryRead = (method: string, path: string, query: string) =>
  [
    "GET /info/refs?service=git-upload-pack",
    "POST /git-upload-pack",
    "GET /info/refs?service=git-receive-pack",
  ].includes(`${method} ${path}${query}`);

/** The control plane requests of `widefleet deploy APP` for the build's app. */
const deployment = (method: string, path: string, appId: string) => {
  const app = `/api/v1/apps/${appId}`;

  const calls = new Map([
    [
      "POST",
      ["/api/v1/apps/source-target", `${app}/source/prepare`, `${app}/assets-upload-session`],
    ],
    ["PUT", [`${app}/assets/[^/]+/[^/]+`, `${app}/worker`]],
    ["GET", [`${app}/network`]],
  ]);

  return (calls.get(method) ?? []).some((pattern) => new RegExp(`^${pattern}$`).test(path));
};

/** Every HTTP and HTTPS request of a build reaches this entrypoint. */
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
  override async fetch(request: Request) {
    const url = new URL(request.url);
    const { appId, build, platform } = this.ctx.props;

    if (url.protocol === "https:" && url.hostname === registry)
      return fetch(request, { redirect: "manual" });

    const repository = new URL(this.ctx.props.repository);

    if (url.origin === repository.origin && url.pathname.startsWith(repository.pathname)) {
      if (
        !repositoryRead(request.method, url.pathname.slice(repository.pathname.length), url.search)
      )
        return denied(request);

      const headers = new Headers(request.headers);
      headers.set("authorization", await this.#repositoryAuthorization());

      return fetch(new Request(request, { headers }), { redirect: "manual" });
    }

    if (url.origin === platform.origin && deployment(request.method, url.pathname, appId)) {
      const headers = new Headers(request.headers);
      headers.set("authorization", platform.authorization);
      headers.set("x-widefleet-organization", platform.organizationId);

      // The build publishes once, however often it runs.
      if (request.method === "PUT" && url.pathname.endsWith("/worker"))
        headers.set("idempotency-key", build);

      return fetch(new Request(request, { headers }), { redirect: "manual" });
    }

    return denied(request);
  }

  /**
   * Repository tokens are short-lived, so each request gets one from the
   * control plane. As with `widefleet deploy`, it is the starter's write
   * credential; the Git requests above only read.
   */
  async #repositoryAuthorization() {
    const { appId, platform, repository } = this.ctx.props;

    const response = await fetch(
      `${platform.origin}/api/v1/apps/${appId}/source/write-credential`,
      {
        method: "POST",
        headers: {
          authorization: platform.authorization,
          "x-widefleet-organization": platform.organizationId,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );

    if (!response.ok) throw new Error(`The repository credential was refused: ${response.status}`);

    const credential = sourceCredential.parse(await response.json());

    if (credential.url !== repository)
      throw new Error("The repository credential is for another repository");

    return `Basic ${btoa(`${credential.username}:${credential.password}`)}`;
  }
}

/** One build, named by its ID, and the container it runs in. */
export class BuildSandbox extends DurableObject<Env> {
  readonly #container: Container;

  readonly #exports: BuildSandboxState["exports"];

  constructor(ctx: BuildSandboxState, env: Env) {
    super(ctx, env);
    const container = ctx.container;

    if (!container) throw new Error("The build container is not configured");
    this.#container = container;
    this.#exports = ctx.exports;
  }

  #current: Promise<z.infer<typeof ciBuildResult>> | undefined;

  build(request: z.infer<typeof ciBuildRequest>) {
    // A repeated call joins the run in progress or returns the recorded outcome,
    // which stays after the build is released.
    if (this.#current) return this.#current;

    const recorded = this.#recorded();

    if (recorded) return recorded;

    this.#current = this.#build(request).finally(() => {
      this.#current = undefined;
    });

    return this.#current;
  }

  /** The outcome of a build that ran, waiting for one that is running. */
  result() {
    return this.#current ?? this.#recorded();
  }

  // Intercepts last as long as the container, so each run registers them.
  async #intercept(request: z.infer<typeof ciBuildRequest>) {
    const outbound = this.#exports.Outbound({
      props: {
        appId: request.appId,
        build: request.id,
        repository: request.repository.url,
        platform: {
          origin: new URL(request.platform.url).origin,
          organizationId: request.platform.organizationId,
          authorization: `Bearer ${request.platform.token}`,
        },
      },
    });

    // "*" covers HTTPS on port 443 only; a control plane can use another port.
    const platform = new URL(request.platform.url);

    if (platform.protocol === "https:" && platform.port)
      await this.#container.interceptOutboundHttps(platform.host, outbound);

    await this.#container.interceptOutboundHttps("*", outbound);
    await this.#container.interceptAllOutboundHttp(outbound);
  }

  #recorded() {
    const recorded = ciBuildResult.safeParse(this.ctx.storage.kv.get("result"));

    return recorded.success ? recorded.data : null;
  }

  async #build(request: z.infer<typeof ciBuildRequest>) {
    if (this.#container.running) await this.#container.destroy();

    const image = this.#container.images["build"];

    if (!image) throw new Error("The build image is not configured");

    const { commit, branch, directory } = request.source;
    const project = directory === "." ? source : `${source}/${directory}`;

    const environment = {
      CI: "true",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSL_CAINFO: certificates,
      NODE_EXTRA_CA_CERTS: certificates,
      SSL_CERT_FILE: certificates,
      PLATFORM_URL: request.platform.url,
      PLATFORM_ORGANIZATION: request.platform.organizationId,
      // The CLI sends it; the Outbound entrypoint replaces it with the build's token.
      PLATFORM_ACCESS_TOKEN: "replaced-by-the-ci",
    };

    let log = "";

    // No run goes past the build's deadline. The alarm stops the container then
    // even if this object restarts in between.
    const deadlineAt = request.deadline;

    this.ctx.storage.kv.put("deadline", deadlineAt);
    await this.ctx.storage.setAlarm(deadlineAt);

    const deadline = new AbortController();

    // Stopping the container also ends processes that outlive their command.
    const timer = setTimeout(
      () => {
        deadline.abort();
        void this.#container.destroy();
      },
      Math.max(0, deadlineAt - Date.now()),
    );

    const run = async (argv: string[], cwd: string, logged = true) => {
      if (logged) log += `$ ${argv.join(" ")}\n`;

      const process = await this.#container.exec(argv, {
        cwd,
        env: environment,
        stdout: "pipe",
        stderr: "combined",
        signal: deadline.signal,
      });

      // Only the end of the output is kept, however much a command prints.
      let text = "";

      if (process.stdout)
        for await (const chunk of process.stdout.pipeThrough(new TextDecoderStream())) {
          text = `${text}${chunk}`.slice(-logLimit);

          if (logged) log = `${log}${chunk}`.slice(-logLimit);
        }

      return { text, exitCode: await process.exitCode };
    };

    // A command ended by the deadline fails like any other.
    const failed = (message: string) => ({
      status: "failed" as const,
      message:
        deadline.signal.aborted || Date.now() >= deadlineAt
          ? "The build did not finish in time"
          : message,
      log,
    });

    const result = await (async (): Promise<z.infer<typeof ciBuildResult>> => {
      try {
        if (Date.now() >= deadlineAt) return failed("");

        // HTTPS intercepts are registered before start(), so the CA exists when it runs.
        await this.#intercept(request);

        if (Date.now() >= deadlineAt) return failed("");

        // A release while intercepts were registered ends the build before it starts.
        if (this.ctx.storage.kv.get("released")) return failed("The build was released");

        this.#container.start({ image, instance: "standard-2", enableInternet: false });
        await this.#container.setInactivityTimeout(inactivityTimeout);

        // The checkout is on the app's branch, as `widefleet deploy` expects.
        const checkout = [
          ["git", "clone", "--no-checkout", "--quiet", request.repository.url, source],
          ["git", "-C", source, "checkout", "--quiet", "-B", branch, commit],
        ];

        for (const argv of checkout)
          if ((await run(argv, "/build")).exitCode !== 0)
            return failed(`${argv.slice(0, 2).join(" ")} failed`);

        // As `widefleet deploy`, a project without package.json has nothing to install.
        if ((await run(["test", "-f", "package.json"], project, false)).exitCode === 0) {
          const install = await run(["pnpm", "install", "--frozen-lockfile"], project);

          if (install.exitCode !== 0)
            return failed(`pnpm install failed with exit code ${install.exitCode}`);
        }

        // `widefleet deploy` would commit changed files, but builds cannot push.
        const changed = await run(["git", "-C", source, "status", "--porcelain"], "/build");

        if (changed.exitCode !== 0 || changed.text.trim())
          return failed(
            "pnpm install changed files of the repository. Commit them or ignore them in Git",
          );

        const deploy = await run(["widefleet", "deploy", "--no-wait", request.appId], project);

        if (deploy.exitCode !== 0)
          return failed(`widefleet deploy failed with exit code ${deploy.exitCode}`);

        return { status: "succeeded", log };
      } catch (error) {
        return failed(
          `The build stopped: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);

        if (this.#container.running) await this.#container.destroy();
      }
    })();

    // The log is kept until the control plane releases the build, at most for a day.
    const expiresAt = Date.now() + logLifetime;

    this.ctx.storage.kv.put("result", result);
    this.ctx.storage.kv.put("expires", expiresAt);
    await this.ctx.storage.setAlarm(expiresAt);

    return result;
  }

  // Stops a container past the build's deadline and drops the log of an outcome
  // nobody released. A failed alarm is retried, so it must not delete itself.
  override async alarm() {
    const now = Date.now();
    const deadlineAt = instant.safeParse(this.ctx.storage.kv.get("deadline")).data ?? 0;

    if (this.#container.running && now >= deadlineAt) await this.#container.destroy();

    const expiresAt = instant.safeParse(this.ctx.storage.kv.get("expires")).data;

    if (expiresAt !== undefined && now >= expiresAt) this.#dropLog("The log expired.\n");
  }

  // A run that reaches this object after the release finds the outcome and
  // does not build again, so the outcome stays. A run in progress does not start
  // its container, records its own outcome and keeps the deadline alarm.
  async release() {
    this.ctx.storage.kv.put("released", true);

    if (this.#container.running) await this.#container.destroy();

    if (this.#current) return;

    if (!this.#recorded())
      this.ctx.storage.kv.put("result", {
        status: "failed",
        message: "The build was released before it finished",
        log: "",
      } satisfies z.infer<typeof ciBuildResult>);

    this.#dropLog("");
    await this.ctx.storage.deleteAlarm();
  }

  #dropLog(log: string) {
    const recorded = this.#recorded();

    if (recorded) this.ctx.storage.kv.put("result", { ...recorded, log });

    this.ctx.storage.kv.delete("expires");
  }
}

/** The control plane's interface to the CI, by build ID. */
export class AppCi extends WorkerEntrypoint<Env> {
  build(input: z.input<typeof ciBuildRequest>) {
    const request = ciBuildRequest.parse(input);

    return this.env.BUILDS.getByName(request.id).build(request);
  }

  result(id: string) {
    return this.env.BUILDS.getByName(id).result();
  }

  release(id: string) {
    return this.env.BUILDS.getByName(id).release();
  }
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
