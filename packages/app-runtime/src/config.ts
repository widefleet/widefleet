import type { Metadata } from "./types.ts";

// The trusted loader supplies immutable metadata to the child's facade module.
declare const WIDEFLEET_CONFIGURATION: {
  metadata: Pick<Metadata, "bindings">;
  capabilities?: string[];
};

export const config = WIDEFLEET_CONFIGURATION;
