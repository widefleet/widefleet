<script lang="ts">
  import KeyRound from "@lucide/svelte/icons/key-round";
  import { Badge } from "@platform/ui/badge";
  import { Button } from "@platform/ui/button";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { getSecretEncryption, reencryptSecrets } from "#lib/encryption.remote";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const encryption = $derived(getSecretEncryption({ organizationId: workspace.organizationId }));

  const status = $derived(
    await encryption.catch((cause: unknown) => {
      if (encryption.error && encryption.error.status >= 500 && encryption.current)
        return encryption.current;
      throw cause;
    }),
  );

  const total = (selected: (version: (typeof status.keyVersions)[number]) => boolean) =>
    status.keyVersions.filter(selected).reduce((sum, version) => sum + version.values, 0);

  // Earlier versions this installation still holds; re-encryption can move these.
  const readable = $derived(total((version) => !version.active && version.available));

  // Values of versions the keyring lacks stay unreadable until the version returns.
  const missing = $derived(total((version) => !version.available));

  const secrets = (count: number) => (count === 1 ? "1 secret" : `${count} secrets`);

  const result = $derived(reencryptSecrets.result);
</script>

<svelte:head><title>Encryption keys · Widefleet</title></svelte:head>
<PageHeading
  title="Encryption keys"
  description="Secrets stored for every organization and the key versions that encrypt them."
/>
<div class="mt-7 max-w-2xl space-y-6">
  {#if encryption.error}<Feedback kind="error"
      >Could not refresh the key versions. The last loaded counts remain visible.</Feedback
    >{/if}
  {#if missing > 0}<Feedback kind="error"
      >{secrets(missing)} use a key version this installation does not have. Add it back to the keyring
      to read them.</Feedback
    >{/if}
  {#if result && (result.reencrypted > 0 || result.changed > 0)}<Feedback kind="success">
      Re-encrypted {secrets(result.reencrypted)} with the active key version.
      {#if result.changed > 0}
        {secrets(result.changed)} changed meanwhile; re-encrypt again to include them.
      {/if}
    </Feedback>{/if}
  {#if result && result.failed > missing}<Feedback kind="error"
      >{secrets(result.failed - missing)} could not be decrypted with their key versions.</Feedback
    >{/if}
  <ul class="divide-y overflow-hidden rounded-xl border" aria-label="Key versions">
    {#each status.keyVersions as version (version.id ?? "")}
      <li class="flex flex-wrap items-center justify-between gap-3 p-5">
        <div class="flex min-w-0 items-center gap-3">
          <span class="bg-muted grid size-9 shrink-0 place-items-center rounded-lg"
            ><KeyRound class="text-muted-foreground size-4" /></span
          >
          <div class="min-w-0">
            <p class="text-sm font-medium wrap-anywhere">
              {version.id ?? "Key of earlier releases"}
            </p>
            <p class="text-muted-foreground mt-1 text-xs">{secrets(version.values)}</p>
          </div>
        </div>
        {#if version.active}<Badge variant="secondary">Encrypts new secrets</Badge>
        {:else if !version.available}<Badge variant="destructive">Missing</Badge>{/if}
      </li>
    {/each}
  </ul>
  {#if status.activeKeyVersion === null}
    <p class="text-muted-foreground text-sm leading-6">
      New secrets use the key of earlier releases. Configure an encryption keyring to protect them
      with key versions.
    </p>
  {:else if readable > 0}
    <form {...reencryptSecrets} class="space-y-3">
      <OrganizationField field={reencryptSecrets.fields.organizationId} />
      <p class="text-muted-foreground text-sm leading-6">
        {secrets(readable)} still use earlier key versions. Re-encrypt them with the active version before
        you remove an earlier key.
      </p>
      <FormIssues issues={reencryptSecrets.fields.allIssues()} />
      <Button type="submit" disabled={reencryptSecrets.pending > 0}
        >{reencryptSecrets.pending ? "Re-encrypting …" : "Re-encrypt secrets"}</Button
      >
    </form>
  {:else if missing === 0}
    <p class="text-muted-foreground text-sm leading-6">
      All stored secrets use the active key version. Keep an earlier version only while a backup you
      may restore still uses it.
    </p>
  {/if}
</div>
