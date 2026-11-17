export type McpPage =
  | {
      kind: "connect";
      handle: string;
      clientName: string;
      redirectHost: string;
      redirectIsLoopback: boolean;
      providers: ("google" | "microsoft")[];
      accounts: { organizationId: string; organizationName: string; name: string }[];
    }
  | {
      kind: "organizations";
      state: string;
      organizations: { id: string; name: string }[];
    }
  | { kind: "error"; message: string };
