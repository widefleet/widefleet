declare module "cloudflare:workers" {
  export const WorkflowEntrypoint: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.WorkflowEntrypoint;
  export const env: import("./lib/server/cloudflare-config.ts").CloudflareBindings;
  export const waitUntil: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.waitUntil;
}
