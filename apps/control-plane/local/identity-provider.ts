import { createEmulator } from "emulate";
import { rm, writeFile, rename } from "node:fs/promises";
import { z } from "zod";
import {
  adminEmail,
  authority,
  clientId,
  clientSecret,
  memberEmail,
  platformUrl,
  requireLocal,
  tenant,
} from "./settings.ts";

requireLocal();

await rm("/data/identity.env", { force: true });

const emulator = await createEmulator({
  service: "microsoft",
  hostname: "0.0.0.0",
  port: 25452,
  baseUrl: authority,
  seed: {
    tokens: {
      local_admin_fixture: { login: adminEmail },
      local_member_fixture: { login: memberEmail },
    },
    microsoft: {
      users: [
        { email: adminEmail, name: "Local Admin", tenant_id: tenant },
        { email: memberEmail, name: "Team Member", tenant_id: tenant },
      ],
      oauth_clients: [
        {
          client_id: clientId,
          client_secret: clientSecret,
          tenant_id: tenant,
          name: "Widefleet local demo",
          redirect_uris: [
            `${platformUrl}/api/auth/callback/microsoft`,
            "https://auth.apps.localhost:25453/oauth2/callback",
          ],
        },
      ],
    },
  },
});

const identities = [];

for (const [email, token, userId] of [
  [adminEmail, "local_admin_fixture", "local-admin"],
  [memberEmail, "local_member_fixture", "local-member"],
] as const) {
  const response = await fetch(`${authority}/v1.0/me`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) throw new Error("Could not read the emulator identity");
  const profile = z.object({ id: z.uuid(), displayName: z.string() }).parse(await response.json());
  identities.push({ userId, email, name: profile.displayName, objectId: profile.id });
}

await writeFile("/data/identities.json", JSON.stringify(identities), { mode: 0o600 });

await writeFile("/data/identity.env.tmp", "# Local identity provider ready\n", {
  mode: 0o600,
});

await rename("/data/identity.env.tmp", "/data/identity.env");

console.info("Local Microsoft emulator ready");

process.on("SIGTERM", () => {
  void emulator.close().then(() => process.exit(0));
});
