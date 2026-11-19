export type McpPage =
  | {
      kind: "connect";
      handle: string;
      authorize: string;
      clientName: string;
      redirectHost: string;
      redirectIsLoopback: boolean;
      accounts: { organizationId: string; organizationName: string; name: string }[];
      organizations: { id: string; name: string }[];
    }
  | { kind: "unavailable"; handle: string; authorize: string; email: string }
  | { kind: "error"; message: string };
