import { googleDirectoryCredentials, groupSearch, groupSearchResult } from "@platform/contracts";
import { APIError } from "better-auth/api";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";

const scope = "https://www.googleapis.com/auth/admin.directory.group.readonly";

const tokenEndpoint = "https://oauth2.googleapis.com/token";

const tokens = new Map<string, { value: string; expiresAt: number }>();

const exchanges = new Map<string, Promise<{ value: string; expiresAt: number }>>();

const page = z.object({
  groups: z
    .array(
      z.object({ id: z.string().min(1), name: z.string(), description: z.string().optional() }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

const requireSuccess = (response: Response) => {
  if (!response.ok)
    throw new APIError(
      "SERVICE_UNAVAILABLE",
      { message: "Google Workspace directory is unavailable" },
      response.status === 429
        ? { "Retry-After": response.headers.get("retry-after") ?? "1" }
        : undefined,
    );
};

export const createGoogleDirectory = (
  input: z.infer<typeof googleDirectoryCredentials>,
  request: typeof fetch = fetch,
) => {
  const credentials = googleDirectoryCredentials.parse(input);

  const fingerprint = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(JSON.stringify(credentials)))
    .then((hash) =>
      Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );

  const accessToken = async () => {
    const key = await fingerprint;
    const cached = tokens.get(key);

    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;
    const existing = exchanges.get(key);

    if (existing) return (await existing).value;

    const pending = (async () => {
      const assertion = await new SignJWT({ scope })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(credentials.clientId)
        .setSubject(credentials.adminEmail)
        .setAudience(tokenEndpoint)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(await importPKCS8(credentials.clientSecret, "RS256"));

      const response = await request(tokenEndpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      });

      requireSuccess(response);

      const result = z
        .object({ access_token: z.string().min(1), expires_in: z.number().positive() })
        .parse(await response.json());

      return { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
    })();

    // Cache only the service credential, never membership decisions. Bound memory
    // across organizations and share concurrent token exchanges in this isolate.
    exchanges.set(key, pending);

    try {
      const token = await pending;

      if (tokens.size >= 64) tokens.delete(tokens.keys().next().value ?? "");
      tokens.set(key, token);

      return token.value;
    } finally {
      exchanges.delete(key);
    }
  };

  const read = async (parameters: URLSearchParams) => {
    const url = new URL("https://admin.googleapis.com/admin/directory/v1/groups");
    url.search = parameters.toString();

    const send = async () => {
      const credential = await accessToken();

      const response = await request(url, {
        headers: { authorization: `Bearer ${credential}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });

      const key = await fingerprint;

      if (response.status === 401 && tokens.get(key)?.value === credential) tokens.delete(key);

      return response;
    };

    const first = await send();
    const response = first.status === 401 ? await send() : first;

    requireSuccess(response);

    return page.parse(await response.json());
  };

  return {
    memberships: async (userId: string) => {
      const groups = new Set<string>();
      const visited = new Set<string>();
      let next = "";

      do {
        if (visited.has(next) || visited.size >= 100) throw new Error("Invalid group pagination");
        visited.add(next);

        const result = await read(
          new URLSearchParams({ userKey: userId, maxResults: "200", pageToken: next }),
        );

        for (const group of result.groups) groups.add(group.id);
        next = result.nextPageToken ?? "";
      } while (next);

      return [...groups];
    },
    search: async (input: z.infer<typeof groupSearch>) => {
      const query = groupSearch.parse(input);
      // Keep user input inside one Google Directory query literal.
      const term = query.query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

      const result = await read(
        new URLSearchParams({
          customer: "my_customer",
          query: `name:'${term}'*`,
          maxResults: String(query.limit + 1),
        }),
      );

      return groupSearchResult.parse({
        groups: result.groups.slice(0, query.limit).map((group) => ({
          id: group.id,
          name: group.name,
          description: group.description ?? null,
          source: "Google Workspace",
        })),
        hasMore: result.groups.length > query.limit || Boolean(result.nextPageToken),
      });
    },
  };
};
