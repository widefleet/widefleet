<script lang="ts">
  import { getAppContext } from "#lib/app-context";
  import { getAppSecrets, putAppSecret, deleteAppSecret } from "#lib/services.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Textarea } from "#shadcn/components/ui/textarea/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { Button } from "#shadcn/components/ui/button/index.js";

  const context = getAppContext();

  const appId = $derived(context.data.app.id);

  const request = $derived(getAppSecrets({ appId }));

  const secrets = $derived(await request);
</script>

<section class="max-w-xl space-y-6">
  <div>
    <h2 class="font-semibold">Secrets</h2>
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
  {#each secrets.names as name (name)}
    {@const removal = deleteAppSecret.for(name)}
    <form {...removal} class="flex items-center justify-between gap-4 rounded-lg border p-4">
      <OrganizationField field={removal.fields.organizationId} /><input
        {...removal.fields.appId.as("hidden", appId)}
      /><input {...removal.fields.secret.as("hidden", name)} />
      <code>{name}</code><FormIssues issues={removal.fields.allIssues()} /><Button
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
