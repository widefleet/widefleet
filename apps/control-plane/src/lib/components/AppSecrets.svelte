<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import { getAppSecrets, putAppSecret, deleteAppSecret } from "#lib/services.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Input } from "@platform/ui/input";
  import { Textarea } from "@platform/ui/textarea";
  import { Label } from "@platform/ui/label";
  import { Button } from "@platform/ui/button";
  import StatusBadge from "./StatusBadge.svelte";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const context = getAppContext();

  const appId = $derived(context.data.app.id);

  const request = $derived(getAppSecrets({ organizationId: workspace.organizationId, appId }));

  const secrets = $derived(await request);

  // Required by the latest deployment's version, which secret changes redeploy.
  const missing = $derived(secrets.required.filter((name) => !secrets.names.includes(name)));

  let valueField = $state<HTMLTextAreaElement | null>(null);

  const setMissing = (name: string) => {
    putAppSecret.fields.secret.set(name);
    valueField?.focus();
  };
</script>

<section id="secrets" aria-labelledby="secrets-heading" class="max-w-xl space-y-6">
  <div>
    <h2 id="secrets-heading" class="text-base font-semibold">Secrets</h2>
    <p class="text-muted-foreground mt-2 text-sm">
      Only this app receives these values. Connected apps can call its API without receiving its
      secrets.
    </p>
  </div>
  <p class="text-sm">
    {secrets.revision === 0
      ? "No secrets configured"
      : secrets.revision === secrets.appliedRevision
        ? "Active"
        : secrets.deployment?.status === "failed"
          ? "Activation failed. Submit the change again to retry."
          : context.data.app.activeDeploymentId
            ? "Activation pending"
            : "Saved. Deploy the app to activate."}
  </p>
  <Button variant="outline" onclick={() => request.refresh()}>Refresh status</Button>
  {#if missing.length > 0}
    <p class="text-sm">
      The app requires secrets that are not set. Set them to complete its setup; deployments fail
      without them.
    </p>
  {/if}
  {#each missing as name (name)}
    <div class="flex items-center justify-between gap-4 rounded-lg border p-4">
      <span class="flex min-w-0 flex-wrap items-center gap-2"
        ><code class="break-all">{name}</code><StatusBadge tone="pending" label="Missing" /></span
      ><Button variant="outline" onclick={() => setMissing(name)}>Set value</Button>
    </div>
  {/each}
  {#each secrets.names as name (name)}
    {@const removal = deleteAppSecret.for(name)}
    <form {...removal} class="flex items-center justify-between gap-4 rounded-lg border p-4">
      <OrganizationField field={removal.fields.organizationId} /><input
        {...removal.fields.appId.as("hidden", appId)}
      /><input {...removal.fields.secret.as("hidden", name)} />
      <span class="flex min-w-0 flex-wrap items-center gap-2"
        ><code class="break-all">{name}</code>{#if secrets.required.includes(name)}<StatusBadge
            tone="neutral"
            label="Required"
          />{/if}</span
      ><FormIssues issues={removal.fields.allIssues()} /><Button
        variant="outline"
        type="submit"
        disabled={removal.pending > 0}>Remove</Button
      >
    </form>
  {/each}
  <form {...putAppSecret} class="space-y-4 rounded-lg border p-4">
    <OrganizationField field={putAppSecret.fields.organizationId} /><input
      {...putAppSecret.fields.appId.as("hidden", appId)}
    /><FormIssues issues={putAppSecret.fields.allIssues()} />
    <h3 class="text-sm font-medium">Add or replace a secret</h3>
    <div class="space-y-2">
      <Label for="secret-name">Name</Label><Input
        id="secret-name"
        {...putAppSecret.fields.secret.as("text")}
        required
      />
    </div>
    <div class="space-y-2">
      <Label for="secret-value">Value</Label><Textarea
        bind:ref={valueField}
        id="secret-value"
        {...putAppSecret.fields._value.as("text")}
        autocomplete="new-password"
        spellcheck={false}
        required
      />
    </div>
    <Button type="submit" disabled={putAppSecret.pending > 0}>Save secret</Button>
  </form>
</section>
