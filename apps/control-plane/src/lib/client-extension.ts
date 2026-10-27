import type { sanitizeReportingError } from "@platform/contracts";

export interface ClientContext {
  user: { id: string } | null;
  organization: { id: string; name: string } | null;
  role: string | null;
  route: string | null;
  url: string;
}

export interface ClientExtension {
  start?: () => void | (() => void | Promise<void>);
  update?: (context: ClientContext) => void | Promise<void>;
  exception?: (error: ReturnType<typeof sanitizeReportingError>) => void | Promise<void>;
  reset?: () => void | Promise<void>;
}

// Replaced only when an installation supplies a browser extension at build time.
export const clientExtension: ClientExtension = {};
