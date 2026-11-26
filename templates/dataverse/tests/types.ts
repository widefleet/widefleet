// Compiled by `pnpm typecheck`: the results a consuming app sees.
import type Dataverse from "../src/app.ts";

declare const dataverse: Dataverse;

export const examples = async () => {
  const environment = "contoso.api.crm4.dynamics.com";

  const accounts = await dataverse.listRows({
    environment,
    entitySet: "accounts",
    $select: ["name", "accountnumber"],
    $filter: "statecode eq 0",
    $top: 10,
  });

  if (accounts.status === "connected")
    for (const row of accounts.data.value ?? []) void row["name"];

  const me = await dataverse.whoAmI({ environment });

  if (me.status === "connected") {
    const user: string | null | undefined = me.data.UserId;
    void user;
  }

  // Bound actions take the row's ID and typed parameters.
  await dataverse.addPrivilegesRole({
    environment,
    id: "00000000-0000-0000-0000-000000000001",
    body: {
      Privileges: [{ PrivilegeId: "00000000-0000-0000-0000-000000000002", Depth: "Basic" }],
    },
  });

  await dataverse.addPrivilegesRole({
    environment,
    id: "x",
    // @ts-expect-error A privilege's depth is one of Dataverse's members.
    body: { Privileges: [{ Depth: "Everything" }] },
  });

  // @ts-expect-error A row needs its entity set.
  await dataverse.getRow({ environment, id: "00000000-0000-0000-0000-000000000001" });

  // @ts-expect-error Every method needs the environment.
  await dataverse.whoAmI({});

  // Lists, objects and rows of functions are typed as their values.
  await dataverse.retrieveTotalRecordCount({ environment, EntityNames: ["account", "contact"] });

  // @ts-expect-error A function's list holds its type's values.
  await dataverse.retrieveTotalRecordCount({ environment, EntityNames: [1] });

  const environments = await dataverse.listEnvironments();

  if (environments.status === "connected") void environments.environments[0]?.environment;
};
