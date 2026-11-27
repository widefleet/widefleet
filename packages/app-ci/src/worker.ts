// Builds commits from Widefleet Git in a Linux container, as `widefleet deploy`
// builds on a computer: install the locked dependencies, then run
// `widefleet build --output`. The output stays in the container until the
// control plane has read it and releases the build. Only the control plane
// reaches the CI, through a service binding to `AppCi`.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  buildSourcePath,
  ciBuildOutput,
  ciBuildRequest,
  ciBuildResult,
} from "@platform/contracts/builds";
import { z } from "zod";

const registry = "registry.npmjs.org";

const source = "/build/source";

const output = "/build/output";

// Intercepted HTTPS is signed with the Containers CA. Commands do not inherit
// the environment of start(), so each command receives it.
const certificates = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

const environment = {
  CI: "true",
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSL_CAINFO: certificates,
  NODE_EXTRA_CA_CERTS: certificates,
  SSL_CERT_FILE: certificates,
};

// The log keeps the end of the output, where failures are reported.
const logLimit = 256 * 1024;

// A build that does not finish by then is stopped.
const buildDeadline = 30 * 60 * 1000;

// Stops a container whose build is never released.
const inactivityTimeout = 15 * 60 * 1000;

interface Env {
  BUILDS: DurableObjectNamespace<BuildSandbox>;
}

interface OutboundProps {
  /** The repository's origin and the Authorization header for it. */
  git: { origin: string; authorization: string };
}

interface BuildSandboxState extends DurableObjectState {
  readonly exports: { Outbound: (options: { props: OutboundProps }) => Fetcher };
}

const decoder = new TextDecoder();

const finished = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), log: z.string() }),
  z.object({ status: z.literal("failed"), message: z.string(), log: z.string() }),
]);

/**
 * Every HTTP and HTTPS request of a build reaches this entrypoint. Builds reach
 * the npm registry and their repository, whose credential stays in the Worker.
 */
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
  override fetch(request: Request) {
    const url = new URL(request.url);

    if (url.protocol === "https:" && url.hostname === registry) return fetch(request);

    if (url.origin === this.ctx.props.git.origin) {
      const headers = new Headers(request.headers);
      headers.set("authorization", this.ctx.props.git.authorization);

      return fetch(new Request(request, { headers }));
    }

    return new Response(`Builds reach only ${registry} and the app's repository\n`, {
      status: 403,
    });
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

    // Each Durable Object instance sets its own timeout.
    if (container.running)
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(inactivityTimeout));
  }

  async build(request: z.infer<typeof ciBuildRequest>) {
    // A retried build reads the output its first attempt left in the container.
    const recorded = finished.safeParse(this.ctx.storage.kv.get("result"));

    if (recorded.success && this.#container.running) {
      if (recorded.data.status === "failed") return ciBuildResult.parse(recorded.data);

      return ciBuildResult.parse({ ...recorded.data, output: await this.#text("deployment.json") });
    }

    if (this.#container.running) await this.#container.destroy();

    const repository = new URL(request.repository.url);
    const image = this.#container.images["build"];

    if (!image) throw new Error("The build image is not configured");
    this.#container.start({ image, instance: "standard-2", enableInternet: false });

    const outbound = this.#exports.Outbound({
      props: {
        git: {
          origin: repository.origin,
          authorization: `Basic ${btoa(`${request.repository.username}:${request.repository.password}`)}`,
        },
      },
    });

    // Without Internet access, only HTTP and HTTPS leave the container, through Outbound.
    await this.#container.interceptAllOutboundHttp(outbound);
    await this.#container.interceptOutboundHttps("*", outbound);
    await this.#container.setInactivityTimeout(inactivityTimeout);

    const project = request.directory === "." ? source : `${source}/${request.directory}`;

    const steps = [
      { argv: ["git", "clone", "--no-checkout", "--quiet", request.repository.url, source] },
      { argv: ["git", "-C", source, "checkout", "--quiet", "--detach", request.commit] },
      { argv: ["pnpm", "install", "--frozen-lockfile"], cwd: project },
      { argv: ["widefleet", "build", "--output", output], cwd: project },
    ];

    let log = "";

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), buildDeadline);

    const result = await (async () => {
      try {
        for (const step of steps) {
          log += `$ ${step.argv.join(" ")}\n`;

          const process = await this.#container.exec(step.argv, {
            cwd: step.cwd ?? "/build",
            env: environment,
            stdout: "pipe",
            stderr: "combined",
            signal: deadline.signal,
          });

          const { stdout, exitCode } = await process.output();
          log = `${log}${decoder.decode(stdout)}`.slice(-logLimit);

          if (exitCode !== 0)
            return {
              status: "failed" as const,
              message: deadline.signal.aborted
                ? `The build did not finish within ${buildDeadline / 60_000} minutes`
                : `${step.argv.slice(0, 2).join(" ")} failed with exit code ${exitCode}`,
              log,
            };
        }

        const text = await this.#text("deployment.json");
        const built = ciBuildOutput.safeParse(JSON.parse(text));

        if (!built.success)
          return {
            status: "failed" as const,
            message: `The build output is invalid: ${z.prettifyError(built.error)}`,
            log,
          };

        return { status: "succeeded" as const, log, output: text };
      } finally {
        clearTimeout(timer);
      }
    })();

    // The output stays in the container; a retry reads it there.
    this.ctx.storage.kv.put(
      "result",
      result.status === "failed" ? result : { status: result.status, log: result.log },
    );

    return ciBuildResult.parse(result);
  }

  /** A file of the build output, by its path in `deployment.json`. */
  async file(path: string) {
    return this.#read(buildSourcePath.parse(path));
  }

  async release() {
    this.ctx.storage.kv.delete("result");

    if (this.#container.running) await this.#container.destroy();
  }

  async #text(path: string) {
    return decoder.decode(await this.#read(path));
  }

  async #read(path: string) {
    if (!this.#container.running) throw new Error("The build output is no longer available");

    const process = await this.#container.exec(["cat", "--", `${output}/${path}`], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const { stdout, stderr, exitCode } = await process.output();

    if (exitCode !== 0) throw new Error(`Cannot read ${path}: ${decoder.decode(stderr).trim()}`);

    return new Uint8Array(stdout);
  }
}

/** The control plane's interface to the CI, by build ID. */
export class AppCi extends WorkerEntrypoint<Env> {
  build(input: z.input<typeof ciBuildRequest>) {
    const request = ciBuildRequest.parse(input);

    return this.env.BUILDS.getByName(request.id).build(request);
  }

  file(id: string, path: string) {
    return this.env.BUILDS.getByName(id).file(path);
  }

  release(id: string) {
    return this.env.BUILDS.getByName(id).release();
  }
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
