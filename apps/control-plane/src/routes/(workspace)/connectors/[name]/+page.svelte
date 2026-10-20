<script lang="ts">
  import { getConnector, setConnectorSecret, deleteConnectorSecret } from "#lib/connectors.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const request = $derived(getConnector(data.name));

  const connector = $derived(await request);

  let refreshing = $state(false);

  let message = $state("");

  const refresh = async () => {
    refreshing = true;
    message = "";

    try {
      await request.refresh();
    } catch {
      message = "Could not refresh connector status. Try again.";
    } finally {
      refreshing = false;
    }
  };
</script>

<svelte:head><title>{data.name} · Connectors · Widefleet</title></svelte:head>
<div class="mx-auto max-w-2xl space-y-8">
  <Button href="/connectors" variant="ghost" class="-ml-3">All connectors</Button>
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">{data.name}</h1>
      <p class="text-muted-foreground mt-2 text-sm">
        Manage this organization’s connector and secrets.
      </p>
    </div>
    <Badge variant="secondary">{connector.state}</Badge>
  </div>
  {#if data.submitted}<Feedback kind="success"
      >Change submitted. Check the activation status below.</Feedback
    >{/if}
  {#if message}<Feedback kind="error">{message}</Feedback>{/if}
  {#if connector.message}<Feedback kind="error">{connector.message}</Feedback>{/if}
  <section class="space-y-4 rounded-xl border p-5" aria-label="Connector activation">
    <div class="flex items-center justify-between gap-4">
      <h2 class="text-sm font-medium">Activation</h2>
      <Button variant="outline" size="sm" disabled={refreshing} onclick={refresh}
        >Refresh status</Button
      >
    </div>
    <p class="text-muted-foreground text-sm">
      {connector.appliedChecksum === null
        ? "No version is active yet."
        : connector.appliedChecksum === connector.checksum &&
            connector.appliedSecretRevision === connector.secretRevision
          ? "The requested version and secrets are active."
          : "The previously activated version remains in use until this change succeeds."}
    </p>
    <p class="text-muted-foreground text-xs">
      Secret revision: {connector.secretRevision} · Active: {connector.appliedSecretRevision ??
        "none"}
    </p>
    <div class="flex flex-wrap gap-2">
      <Button href={`/connectors/new?name=${data.name}`} variant="outline" size="sm"
        >Deploy update</Button
      >
      <Button href={`/connectors/${data.name}/logs`} variant="outline" size="sm">View logs</Button>
    </div>
  </section>
  <section class="space-y-4" aria-labelledby="secrets-heading">
    <div>
      <h2 id="secrets-heading" class="text-base font-medium">Secrets</h2>
      <p class="text-muted-foreground mt-1 text-sm">
        Values are encrypted and never shown again. Changes activate asynchronously.
      </p>
    </div>
    {#if connector.secrets.length}
      <ul class="divide-y rounded-xl border">
        {#each connector.secrets as secret (secret)}
          {@const remove = deleteConnectorSecret.for(`${data.name}:${secret}`)}
          <li class="p-4">
            <form {...remove} class="flex items-center justify-between gap-3">
              <OrganizationField field={remove.fields.organizationId} />
              <input {...remove.fields.name.as("hidden", data.name)} />
              <input {...remove.fields.secret.as("hidden", secret)} />
              <code class="text-sm">{secret}</code>
              <Button type="submit" variant="outline" size="sm" disabled={remove.pending > 0}
                >Remove {secret}</Button
              >
            </form>
            <FormIssues issues={remove.fields.allIssues()} />
            {#if remove.result?.submitted}<p class="text-muted-foreground mt-2 text-xs">
                Removal submitted.
              </p>{/if}
          </li>
        {/each}
      </ul>
    {:else}<p class="text-muted-foreground text-sm">No secrets configured.</p>{/if}
    <form {...setConnectorSecret} class="space-y-4 rounded-xl border p-5">
      <OrganizationField field={setConnectorSecret.fields.organizationId} />
      <input {...setConnectorSecret.fields.name.as("hidden", data.name)} />
      <FormIssues issues={setConnectorSecret.fields.allIssues()} />
      <h3 class="text-sm font-medium">Add or replace a secret</h3>
      <div class="space-y-2">
        <Label for="secret-name">Secret name</Label>
        <Input
          id="secret-name"
          {...setConnectorSecret.fields.secret.as("text")}
          placeholder="API_KEY"
          required
          autocomplete="off"
        />
      </div>
      <div class="space-y-2">
        <Label for="secret-value">Secret value</Label>
        <Input
          id="secret-value"
          {...setConnectorSecret.fields._value.as("password")}
          required
          autocomplete="new-password"
        />
      </div>
      <Button type="submit" disabled={setConnectorSecret.pending > 0}>Save secret</Button>
    </form>
  </section>
</div>
