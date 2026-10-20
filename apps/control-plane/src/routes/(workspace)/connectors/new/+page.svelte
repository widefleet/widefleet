<script lang="ts">
  import { deployConnector } from "#lib/connectors.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Deploy connector · Widefleet</title></svelte:head>
<div class="mx-auto max-w-xl">
  <Button href="/connectors" variant="ghost" class="mb-6 -ml-3">All connectors</Button>
  <h1 class="text-2xl font-semibold tracking-tight">Deploy connector</h1>
  <p class="text-muted-foreground mt-2 text-sm leading-6">
    Upload a bundled connector and its upload metadata. Reusing a name updates that connector in
    your organization and preserves its secrets.
  </p>
  <form {...deployConnector} enctype="multipart/form-data" class="mt-8 space-y-6">
    <OrganizationField field={deployConnector.fields.organizationId} />
    <input {...deployConnector.fields.requestId.as("hidden", data.requestId)} />
    <FormIssues issues={deployConnector.fields.allIssues()} />
    <div class="space-y-2">
      <Label for="connector-name">Connector name</Label>
      <Input
        id="connector-name"
        name={deployConnector.fields.name.as("text").name}
        aria-invalid={deployConnector.fields.name.as("text")["aria-invalid"]}
        bind:value={
          () => deployConnector.fields.name.value() ?? data.name,
          (value) => deployConnector.fields.name.set(value)
        }
        required
        placeholder="erp"
      />
    </div>
    <div class="space-y-2">
      <Label for="connector-metadata">Upload metadata</Label>
      <Input
        id="connector-metadata"
        {...deployConnector.fields.metadata.as("file")}
        accept=".json,application/json"
        required
      />
      <p class="text-muted-foreground text-xs leading-5">
        A JSON file matching the ConnectorUploadMetadata schema in the <a
          href="/api/v1/openapi.json"
          class="underline">API reference</a
        >, including the main module, entrypoints and resource bindings.
      </p>
    </div>
    <div class="space-y-2">
      <Label for="connector-modules">Bundled modules</Label>
      <Input
        id="connector-modules"
        {...deployConnector.fields.modules.as("file multiple")}
        required
      />
      <p class="text-muted-foreground text-xs leading-5">
        Select JavaScript modules (.js or .mjs), source maps (.map), WebAssembly (.wasm), text
        (.txt) and binary files. Filenames must match the bundle’s imports and metadata.
      </p>
    </div>
    <div class="flex items-center justify-between border-t pt-6">
      <Button href="/connectors" variant="ghost">Cancel</Button>
      <Button type="submit" disabled={deployConnector.pending > 0}
        >{deployConnector.pending ? "Submitting…" : "Deploy connector"}</Button
      >
    </div>
  </form>
</div>
