import * as contract from "@platform/contracts";
import { z } from "zod";
import {
  cloudflareResourceName,
  type createCloudflareProvisioner,
} from "./cloudflare-provisioning.ts";

export const provisionConnectorResources = async (
  provisioner: ReturnType<typeof createCloudflareProvisioner>,
  fleetId: string,
  release: z.infer<typeof contract.connectorPackage>,
) => {
  const scope = `${fleetId}/connector/${release.name}`;
  const resources = [];
  const nativeBindings: Record<string, string> = {};

  const native = (name: string, kind: string, identity: string) => {
    const binding = `B_${cloudflareResourceName(scope, kind, identity)}`;
    nativeBindings[name] = binding;

    return binding;
  };

  for (const binding of release.configuration.d1_databases)
    resources.push({
      type: "d1" as const,
      name: native(binding.binding, "d1", binding.database_id ?? binding.database_name),
      id: await provisioner.ensureDatabase(
        cloudflareResourceName(scope, "d1", binding.database_id ?? binding.database_name),
      ),
    });

  for (const binding of release.configuration.r2_buckets) {
    const name = cloudflareResourceName(scope, "r2", binding.bucket_name);
    await provisioner.ensureBucket(name);
    resources.push({
      type: "r2_bucket" as const,
      name: native(binding.binding, "r2", binding.bucket_name),
      bucket_name: name,
    });
  }

  for (const binding of release.configuration.kv_namespaces)
    resources.push({
      type: "kv_namespace" as const,
      name: native(binding.binding, "kv", binding.id),
      namespace_id: await provisioner.ensureNamespace(
        cloudflareResourceName(scope, "kv", binding.id),
      ),
    });

  return { resources, nativeBindings };
};
