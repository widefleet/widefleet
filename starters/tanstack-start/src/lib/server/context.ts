import type { AppUser } from "./identity.ts";

export interface PlatformContext {
  user: AppUser;
  requestId: string;
  reportedErrors: Set<unknown>;
}
