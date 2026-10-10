import * as contract from "@platform/contracts";
import { eq } from "drizzle-orm";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { account, user, member } from "../src/lib/server/auth-schema.ts";
import { apiResource } from "../src/lib/server/auth-options.ts";
import { createAuthentication } from "../src/lib/server/auth.ts";
import { enrollCompanyUser } from "../src/lib/server/organization.ts";
import { readConfiguration } from "../src/lib/server/config.ts";
import { createDatabase } from "../src/lib/server/database.ts";
import { createSettingsService } from "../src/lib/server/settings.ts";
import { installationKeys } from "../src/lib/server/installation-files.ts";
import { installation } from "../src/lib/server/schema.ts";
import { installationId } from "../src/lib/server/installation-store.ts";
import { requireLocal, tenant, authority, clientId, clientSecret } from "./settings.ts";

requireLocal();

const configuration = readConfiguration();

if (
  configuration.DATABASE_URL !==
  "postgres://widefleet:local-demo-only@postgres:5432/widefleet_local"
)
  throw new Error("Local fixtures require the local Compose database");

const command = process.argv[2];

const stateSchema = z.object({
  agentId: z.uuid(),
  agentToken: z.string(),
  appId: z.uuid(),
  adminAssignmentId: z.uuid().optional(),
});

const stateFile = "/data/demo.json";

const readState = async () => stateSchema.parse(JSON.parse(await readFile(stateFile, "utf8")));

const run = async (executable: string, args: string[], token?: string) => {
  const environment = { ...process.env };

  if (token) environment["PLATFORM_ACCESS_TOKEN"] = token;

  const child = spawn(executable, args, {
    cwd: "/workspace/starters/sveltekit",
    stdio: "inherit",
    env: environment,
  });

  const stop = () => {
    child.kill("SIGTERM");
  };

  process.on("SIGTERM", stop);

  try {
    const [code] = z
      .tuple([z.number().nullable(), z.string().nullable()])
      .parse(await once(child, "exit"));

    if (code !== 0) throw new Error(`${executable} exited unsuccessfully`);
  } finally {
    process.off("SIGTERM", stop);
  }
};

if (command === "agent") {
  process.env["PLATFORM_AGENT_TOKEN"] = (await readState()).agentToken;
  await run("platform-agent", []);
} else {
  const database = createDatabase(configuration);

  try {
    if (command === "seed") {
      const identities = z
        .array(
          z.object({ userId: z.string(), email: z.email(), name: z.string(), objectId: z.uuid() }),
        )
        .parse(JSON.parse(await readFile("/data/identities.json", "utf8")));

      await database.db.transaction(async (transaction) => {
        for (const identity of identities) {
          await transaction
            .insert(user)
            .values({
              id: identity.userId,
              name: identity.name,
              email: identity.email,
              emailVerified: true,
            })
            .onConflictDoNothing();
          await transaction
            .insert(account)
            .values({
              id: `${identity.userId}-microsoft`,
              userId: identity.userId,
              providerId: "microsoft",
              accountId: identity.objectId,
            })
            .onConflictDoUpdate({ target: account.id, set: { accountId: identity.objectId } });
        }
      });
    }

    const auth = createAuthentication(configuration, database.db);

    const identities = await database.db
      .select()
      .from(account)
      .where(eq(account.providerId, "microsoft"));

    for (const identity of identities) await enrollCompanyUser(database.db, identity.userId);

    if (command === "seed") {
      await database.db
        .update(member)
        .set({ role: "owner" })
        .where(eq(member.userId, "local-admin"));
      const keys = await installationKeys(configuration);

      const settings = createSettingsService(
        configuration,
        database.db,
        keys.encryption,
        keys.cookie,
      );

      await settings.initialize({
        externallyManaged: false,
        identity: {
          provider: { type: "entra", tenantId: tenant, authority, label: "Microsoft" },
          management: { clientId, secret: { type: "value", value: clientSecret } },
          apps: { clientId, secret: { type: "value", value: clientSecret } },
          directory: null,
        },
      });
      await database.db
        .update(installation)
        .set({ ownerId: "local-admin", localPasswordEnabled: false })
        .where(eq(installation.id, installationId));
    }

    const now = Math.floor(Date.now() / 1000);

    const { token } = await auth.api.signJWT({
      body: {
        payload: {
          sub: "local-admin",
          aud: apiResource(configuration),
          iss: `${configuration.PLATFORM_URL}/api/auth`,
          iat: now,
          exp: now + 300,
          scope: "platform:read platform:write network:manage",
        },
      },
    });

    const api = async (
      path: string,
      body?:
        | { name: string }
        | z.infer<typeof contract.createAppInput>
        | z.infer<typeof contract.appRoleGrant>
        | { revision: number },
      method: "POST" | "DELETE" = "POST",
    ) => {
      const response = await fetch(`${configuration.PLATFORM_URL}/api/v1${path}`, {
        method: body ? method : "GET",
        headers: {
          authorization: `Bearer ${token}`,
          origin: configuration.PLATFORM_URL,
          "content-type": "application/json",
        },
        body: body ? JSON.stringify(body) : null,
      });

      if (!response.ok)
        throw new Error(`Local API ${path}: ${response.status} ${await response.text()}`);

      return z.json().parse(await response.json());
    };

    if (command === "seed") {
      const current = await readFile(stateFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;

        return null;
      });

      let registration;
      const previous = current ? stateSchema.parse(JSON.parse(current)) : null;

      if (previous) {
        const registered = z.array(contract.agent).parse(await api("/agents"));

        if (!registered.some((entry) => entry.id === previous.agentId && entry.enabled))
          throw new Error("Local agent was disabled; use ./dev reset --yes to start over");
        registration = { agentId: previous.agentId, agentToken: previous.agentToken };
      } else {
        const created = z
          .object({ agent: contract.agent, token: z.string() })
          .parse(await api("/agents", { name: "Local Docker host" }));

        registration = { agentId: created.agent.id, agentToken: created.token };
      }

      const knownApps = z.array(contract.app).parse(await api("/apps"));

      const demo =
        knownApps.find((app) => app.slug === "team-notes") ??
        contract.app.parse(
          await api("/apps", {
            slug: "team-notes",
            displayName: "Team Notes",
            parentId: null,
          }),
        );

      const administrator = identities.find((identity) => identity.userId === "local-admin");

      if (!administrator) throw new Error("Local administrator has no company identity");
      let roles = contract.appRoleState.parse(await api(`/apps/${demo.id}/roles`));
      const provider = `${authority}/${tenant}/v2.0`;
      const principal = { type: "user" as const, provider, subject: administrator.accountId };

      const isCurrent = (assignment: z.infer<typeof contract.appRoleAssignment>) =>
        assignment.role === "admin" &&
        assignment.principal.type === principal.type &&
        assignment.principal.provider === principal.provider &&
        assignment.principal.subject === principal.subject;

      // The emulator recreates object IDs on restart. Add the current admin before
      // removing obsolete seeded admins so the demo never loses its last admin.
      if (!roles.assignments.some(isCurrent))
        roles = contract.appRoleState.parse(
          await api(
            `/apps/${demo.id}/roles`,
            {
              revision: roles.revision,
              principal,
              role: "admin",
            },
            "POST",
          ),
        );

      for (const assignment of roles.assignments.filter(
        (entry) =>
          entry.role === "admin" &&
          !isCurrent(entry) &&
          (entry.id === previous?.adminAssignmentId ||
            (entry.principal.type === "user" &&
              entry.principal.provider === "widefleet" &&
              entry.principal.subject === "local-admin")),
      ))
        roles = contract.appRoleState.parse(
          await api(
            `/apps/${demo.id}/roles/${assignment.id}`,
            {
              revision: roles.revision,
            },
            "DELETE",
          ),
        );

      const seededAdmin = roles.assignments.find(isCurrent);

      if (!seededAdmin) throw new Error("Local app administrator was not assigned");
      await writeFile(
        stateFile,
        JSON.stringify({ ...registration, appId: demo.id, adminAssignmentId: seededAdmin.id }),
        {
          mode: 0o600,
        },
      );
      console.info("Local administrator, agent and example app are ready");
    } else if (command === "deploy") {
      const state = await readState();
      await run("widefleet", ["deploy", state.appId], token);
    } else if (command === "cli") {
      await run("widefleet", process.argv.slice(3), token);
    } else if (command === "app-id") {
      console.info((await readState()).appId);
    } else throw new Error("Unknown local command");
  } finally {
    await database.close();
  }
}
