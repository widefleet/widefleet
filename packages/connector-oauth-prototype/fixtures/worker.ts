import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import GitHubConnector from "../src/connector.ts";
import type { Environment, Properties } from "../src/context.ts";
import { escapeHtml, page } from "./pages.ts";
import schema from "../migrations/0001-better-auth.sql";

interface FixtureEnvironment extends Omit<Environment, "WIDEFLEET_SECRETS"> {
  AUTH_SECRET: string;
  GITHUB_CLIENT_SECRET: string;
  DEMO_COOKIE_KEY: string;
  FIXTURE_TOKEN: string;
}

export class Connector extends GitHubConnector {
  constructor(context: ExecutionContext<Properties>, environment: FixtureEnvironment) {
    super(context, {
      ...environment,
      WIDEFLEET_SECRETS: {
        get: (name) =>
          Promise.resolve(environment[z.enum(["AUTH_SECRET", "GITHUB_CLIENT_SECRET"]).parse(name)]),
      },
    });
  }
}

const identity = z.enum(["alice", "bob"]);

const app = z.enum(["issues", "planning"]);

const names = { alice: "Alice", bob: "Bob" };

const signature = async (key: string, value: string) => {
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signed = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value));

  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const currentUser = async (request: Request, environment: FixtureEnvironment) => {
  const cookies = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim());
  const candidates = cookies.filter((cookie) => cookie.startsWith("demo_identity="));

  if (candidates.length !== 1) return null;
  const [name, proof] = (candidates[0] ?? "").slice("demo_identity=".length).split(".");
  const parsed = identity.safeParse(name);

  return parsed.success && proof === (await signature(environment.DEMO_COOKIE_KEY, parsed.data))
    ? parsed.data
    : null;
};

const login = () =>
  page(
    "Testnutzer wählen",
    `<h1>Mit zwei Nutzern ausprobieren</h1><p>Die Nutzerwahl ersetzt ausschließlich in diesem lokalen Versuch das Firmen-SSO. Der OAuth-Testanbieter erzeugt synthetische Daten.</p><div class="grid">${Object.entries(
      names,
    )
      .map(
        ([id, name]) =>
          `<section class="panel"><h2>${name}</h2><form method="post" action="/demo/user"><input type="hidden" name="user" value="${id}"><button>Als ${name} öffnen</button></form></section>`,
      )
      .join("")}</div>`,
  );

export default class Demo extends WorkerEntrypoint<FixtureEnvironment> {
  override async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/_fixture/")) {
      if (request.headers.get("authorization") !== `Bearer ${this.env.FIXTURE_TOKEN}`)
        return new Response(null, { status: 403 });

      if (url.pathname === "/_fixture/initialize") {
        // Apply the connector's versioned migration once to this empty test database.
        // celld 0.6.2 rejects Better Auth's schema introspection during getMigrations().
        await this.env.DB.batch(
          schema
            .split(";")
            .map((sql) => sql.trim())
            .filter(Boolean)
            .map((sql) => this.env.DB.prepare(sql)),
        );

        return Response.json({ initialized: true });
      }

      if (url.pathname === "/_fixture/expire") {
        await this.env.DB.prepare('UPDATE account SET "accessTokenExpiresAt" = ?')
          .bind(Date.now() - 60_000)
          .run();

        return Response.json({ expired: true });
      }

      if (url.pathname === "/_fixture/accounts")
        return Response.json(
          (
            await this.env.DB.prepare(
              'SELECT "userId", "accountId", "accessToken", "refreshToken" FROM account',
            ).all()
          ).results,
        );

      return new Response(null, { status: 404 });
    }

    if (url.pathname === "/demo/user" && request.method === "POST") {
      if (request.headers.get("origin") !== url.origin) return new Response(null, { status: 403 });
      const name = identity.parse((await request.formData()).get("user"));
      const value = `${name}.${await signature(this.env.DEMO_COOKIE_KEY, name)}`;

      return new Response(null, {
        status: 303,
        headers: {
          location: "/",
          "set-cookie": `demo_identity=${value}; Path=/; HttpOnly; SameSite=Lax`,
        },
      });
    }

    if (url.pathname === "/demo/users") return login();
    const name = await currentUser(request, this.env);

    if (!name)
      return url.pathname.startsWith("/api/") ? new Response(null, { status: 401 }) : login();

    // Test-only trusted boundary. A production gateway must obtain this from verified SSO.
    const connector = this.ctx.exports.Connector({
      props: {
        caller: {
          organizationId: "example-org",
          issuer: "https://identity.example.test",
          subject: name,
          name: names[name],
        },
      },
    });

    if (url.pathname.startsWith("/connector/"))
      return connector.fetch(new Request(request, { redirect: "manual" }));

    const selected = app.safeParse(
      url.pathname.split("/")[url.pathname.startsWith("/api/") ? 3 : 2],
    );

    if (url.pathname.startsWith("/api/apps/") && selected.success)
      return Response.json(await connector.listIssues());

    if (url.pathname === "/") {
      const status = await connector.connectionStatus();

      return page(
        "Connector ausprobieren",
        `<h1>Ein Konto, zwei Apps</h1><p>Angemeldeter Testnutzer: <strong>${names[name]}</strong> · <a href="/demo/users">Nutzer wechseln</a></p><div class="panel"><strong class="${status.status === "connected" ? "success" : ""}">${status.status === "connected" ? `Verbunden mit Test-GitHub-Konto ${escapeHtml(status.githubAccountId ?? "")}` : "GitHub noch nicht verbunden"}</strong><p>Beide Apps verwenden dieselbe persönliche Verbindung dieses Nutzers.</p><nav><a href="/apps/issues">Issues-App öffnen →</a><a href="/apps/planning">Planungs-App öffnen →</a></nav></div><p class="notice">OAuth und Datenhaltung laufen im Connector. Die lokale Umgebung stellt Nutzeridentität und Routing bereit; sie ist keine bereits integrierte Widefleet-Anmeldung.</p>`,
      );
    }

    if (url.pathname.startsWith("/apps/") && selected.success) {
      const result = await connector.listIssues();
      const title = selected.data === "issues" ? "Issues-App" : "Planungs-App";

      return page(
        title,
        `<nav><a href="/">Übersicht</a><a href="/apps/${selected.data === "issues" ? "planning" : "issues"}">Andere App</a><a href="/demo/users">Nutzer wechseln</a></nav><h1>${title}</h1><p>Testnutzer: ${names[name]}</p><section class="panel">${result.status === "connected" ? `<strong class="success">Persönliche Verbindung wird verwendet</strong><ul>${result.issues.map((entry) => `<li>${escapeHtml(entry.title)}</li>`).join("")}</ul><form method="post" action="/connector/disconnect"><button class="secondary">Verbindung für beide Apps trennen</button></form>` : `<strong>${result.status === "reconnect_required" ? "Erneut verbinden erforderlich" : "Für diese Funktion GitHub verbinden"}</strong><p>Der Testanbieter öffnet eine eigene Autorisierungsseite.</p><form method="post" action="/connector/connect"><input type="hidden" name="returnTo" value="${escapeHtml(`${url.origin}/apps/${selected.data}`)}"><button>GitHub verbinden</button></form>`}</section>`,
      );
    }

    return new Response(null, { status: 404 });
  }
}

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
    }
  }
}
