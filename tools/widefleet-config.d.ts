/** The default export of an app's widefleet.config.ts. */
export interface WidefleetConfig {
  network?: {
    backend?: readonly string[];
    browser?: readonly string[];
  };
}
