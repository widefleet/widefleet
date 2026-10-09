import { TaggedError } from "better-result";

export class StorageUnavailable extends TaggedError("StorageUnavailable")<{
  message: string;
  cause: unknown;
}> {}

export class DatabaseUnavailable extends TaggedError("DatabaseUnavailable")<{
  message: string;
  cause: unknown;
}> {}

export class TelemetryNotConfigured extends TaggedError("TelemetryNotConfigured")<{
  message: string;
}> {}

export class TelemetryUnavailable extends TaggedError("TelemetryUnavailable")<{
  message: string;
  cause: unknown;
}> {}

export class InvalidOperation extends TaggedError("InvalidOperation")<{
  code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "BAD_REQUEST";
  message: string;
}> {}
