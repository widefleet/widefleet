declare module "widefleet:app" {
  const app: ExportedHandler<Cloudflare.Env, import("./types.ts").Json | ArrayBuffer>;
  export default app;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./loader.ts");
  }
}

declare module "widefleet:workflow" {
  const workflow: new (
    context: ExecutionContext,
    environment: Record<string, import("./workflow-protocol.ts").WorkflowValue>,
  ) => {
    run(
      event: import("./workflow-protocol.ts").AppEvent,
      step: typeof import("./workflow-runner.ts").workflowSteps,
    ): Promise<import("./workflow-protocol.ts").WorkflowValue>;
  };

  export default workflow;
}
