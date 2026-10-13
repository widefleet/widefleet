import type { Runtime } from "#server/runtime-services";

declare global {
  namespace App {
    interface Locals {
      runtime: () => Promise<Runtime>;
    }
  }
}

export {};
