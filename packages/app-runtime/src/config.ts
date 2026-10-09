import type { Metadata } from "./types.ts";

// The trusted loader supplies immutable metadata to the child's facade module.
declare const WIDEFLEET_CONFIGURATION: { metadata: Metadata };

export const config = WIDEFLEET_CONFIGURATION;
