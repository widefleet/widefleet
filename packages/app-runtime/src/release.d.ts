declare const WIDEFLEET_BINDINGS_SOURCE: string;

declare const WIDEFLEET_EVENTS_SOURCE: string;

declare const WIDEFLEET_RUNTIME_VERSION: string;

// celld exposes explicit isolate release; workerd manages that lifetime itself.
interface WorkerStub {
  dispose?(): void;
}

declare const WIDEFLEET_WORKFLOW_SOURCE: string;
