import { groupSearch, groupSearchResult } from "@platform/contracts";
import { Result, TaggedError } from "better-result";
import { z } from "zod";
import type { Configuration } from "./config.ts";
import type { Principal } from "./identity.ts";
import { InvalidOperation } from "./errors.ts";

export class DirectoryUnavailable extends TaggedError("DirectoryUnavailable")<{
  message: string;
}> {}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const graphGroups = z.object({
  value: z.array(
    z.object({
      id: z.uuid(),
      displayName: z.string().min(1).max(512),
      description: z.string().max(4096).nullable().optional(),
    }),
  ),
  "@odata.nextLink": z.string().optional(),
});

export const createDirectory = (configuration: Configuration, request: typeof fetch = fetch) => {
  let token: { value: string; expiresAt: number } | undefined;
  let pendingToken: Promise<string> | undefined;

  const credentials = () => {
    const identity = configuration.IDENTITY;

    if (!identity || identity.provider.type !== "entra" || !identity.directory)
      throw new DirectoryUnavailable({
        message:
          "Group search is not configured. Ask an administrator to connect the company directory.",
      });

    return { provider: identity.provider, client: identity.directory };
  };

  const accessToken = async () => {
    if (token && token.expiresAt > Date.now() + 30_000) return token.value;

    if (pendingToken) return pendingToken;

    pendingToken = (async () => {
      const { provider, client } = credentials();

      const response = await request(
        `${new URL(provider.authority).origin}/${provider.tenantId}/oauth2/v2.0/token`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: client.clientId,
            client_secret: client.clientSecret,
            scope: "https://graph.microsoft.com/.default",
          }),
        },
      );

      if (!response.ok)
        throw new DirectoryUnavailable({
          message:
            "The directory connection could not authenticate. Ask an administrator to check its credentials and consent.",
        });
      const result = tokenResponse.parse(await response.json());
      token = { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };

      return token.value;
    })();

    try {
      return await pendingToken;
    } finally {
      pendingToken = undefined;
    }
  };

  const search = (input: z.infer<typeof groupSearch>) =>
    Result.tryPromise({
      try: async () => {
        const { provider } = credentials();
        const query = groupSearch.parse(input);
        const url = new URL("https://graph.microsoft.com/v1.0/groups");
        // Quote one search expression; user text must not introduce additional search clauses.
        const term = query.query.replace(/["\\]/g, " ").trim();

        if (!term) throw new DirectoryUnavailable({ message: "Enter a group name to search." });
        url.searchParams.set("$search", `"displayName:${term}"`);
        url.searchParams.set("$select", "id,displayName,description");
        url.searchParams.set("$top", String(query.limit + 1));
        url.searchParams.set("$orderby", "displayName");
        url.searchParams.set("$count", "true");

        const response = await request(url, {
          headers: { authorization: `Bearer ${await accessToken()}`, ConsistencyLevel: "eventual" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          if (response.status === 401) token = undefined;
          throw new DirectoryUnavailable({
            message:
              response.status === 403
                ? "Directory access has not been granted. Ask an administrator to approve the group read permission."
                : "The company directory is temporarily unavailable. Try the search again.",
          });
        }

        const result = graphGroups.parse(await response.json());

        return groupSearchResult.parse({
          groups: result.value.slice(0, query.limit).map((group) => ({
            id: group.id,
            name: group.displayName,
            description: group.description ?? null,
            source: provider.label,
          })),
          hasMore: result.value.length > query.limit || Boolean(result["@odata.nextLink"]),
        });
      },
      catch: (cause) =>
        cause instanceof DirectoryUnavailable
          ? cause
          : new DirectoryUnavailable({
              message:
                "The company directory could not be queried. Try again or ask an administrator to check the connection.",
            }),
    });

  return {
    search: (principal: Principal, input: z.infer<typeof groupSearch>) =>
      Result.gen(async function* () {
        if (!principal.creator && !principal.admin)
          return yield* new InvalidOperation({
            code: "FORBIDDEN",
            message: "App creation permission is required to search company groups",
          });

        return Result.ok(yield* Result.await(search(input)));
      }),
  };
};
