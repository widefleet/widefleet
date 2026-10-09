declare const WIDEFLEET_BINDINGS_SOURCE: string;

declare const WIDEFLEET_EVENTS_SOURCE: string;

declare const WIDEFLEET_RUNTIME_VERSION: string;

// celld's explicit release operation; Cloudflare's types do not expose it.
interface WorkerStub {
  dispose(): void;
}

declare const WIDEFLEET_WORKFLOW_SOURCE: string;
