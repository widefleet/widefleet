declare module "cloudflare:workers" {
  export const env: import("./lib/server/cloudflare-config.ts").CloudflareBindings;
  export const waitUntil: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.waitUntil;
}
