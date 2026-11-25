<script lang="ts">
  import KeyRound from "@lucide/svelte/icons/key-round";
  import { Badge } from "@platform/ui/badge";
  import { Button } from "@platform/ui/button";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { getSecretEncryption, reencryptSecretBatch } from "#lib/encryption.remote";
  import { failureMessage } from "#lib/sso-setup.svelte";
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

  const total = (
    selected: (version: (typeof status.keyVersions)[number]) => boolean,
    field: "values" | "pending" = "values",
  ) => status.keyVersions.filter(selected).reduce((sum, version) => sum + version[field], 0);

  // Earlier versions this installation still holds; re-encryption can move these.
  const readable = $derived(total((version) => !version.active && version.available));

  // Values of versions the keyring lacks stay unreadable until the version returns.
  const missing = $derived(total((version) => !version.available));

  // Pending deployments save their secrets later, still encrypted with these versions.
  const waiting = $derived(total((version) => !version.active, "pending"));

  const secrets = (count: number) => (count === 1 ? "1 secret" : `${count} secrets`);

  let running = $state(false);

  let progress = $state<{ reencrypted: number; changed: number; failed: number } | null>(null);

  let failure = $state("");

  const reencrypt = async () => {
    running = true;
    failure = "";
    progress = { reencrypted: 0, changed: 0, failed: 0 };

    try {
      // Each call handles a bounded batch; done batches stay re-encrypted if a later one fails.
      for (let cursor: string | null = null; ;) {
        // Annotated because the loop's cursor depends on the previous batch.
        const batch: Awaited<ReturnType<typeof reencryptSecretBatch>> = await reencryptSecretBatch({
          organizationId: workspace.organizationId,
          cursor,
        });

        progress = {
          reencrypted: progress.reencrypted + batch.reencrypted,
          changed: progress.changed + batch.changed,
          failed: progress.failed + batch.failed,
        };

        if (batch.cursor === null) break;
        cursor = batch.cursor;
      }
    } catch (cause) {
      failure = failureMessage(cause, "Re-encryption stopped. Try again to continue.");
    } finally {
      running = false;
    }
  };
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
  {#if failure}<Feedback kind="error">{failure}</Feedback>{/if}
  {#if progress && !running && (progress.reencrypted > 0 || progress.changed > 0)}<Feedback
      kind="success"
    >
      Re-encrypted {secrets(progress.reencrypted)} with the active key version.
      {#if progress.changed > 0}
        {secrets(progress.changed)} changed meanwhile; re-encrypt again to include them.
      {/if}
    </Feedback>{/if}
  {#if progress && !running && progress.failed > missing}<Feedback kind="error"
      >{secrets(progress.failed - missing)} could not be decrypted with their key versions.</Feedback
    >{/if}
  {#if status.pendingDeployments > 0}<Feedback>
      {status.pendingDeployments === 1
        ? "1 deployment has"
        : `${status.pendingDeployments} deployments have`} not saved their secrets yet. They keep the
      key versions shown as pending in use until they finish.
    </Feedback>{/if}
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
            <p class="text-muted-foreground mt-1 text-xs">
              {secrets(version.values)}{version.pending > 0
                ? ` · ${version.pending} pending in deployments`
                : ""}
            </p>
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
    <div class="space-y-3">
      <p class="text-muted-foreground text-sm leading-6">
        {secrets(readable)} still use earlier key versions. Re-encrypt them with the active version. Remove
        an earlier key only once it shows 0 secrets and nothing pending.
      </p>
      {#if running && progress}<p class="text-sm" role="status">
          {progress.reencrypted > 0
            ? `Re-encrypted ${secrets(progress.reencrypted)} so far …`
            : "Re-encrypting secrets …"}
        </p>{/if}
      <Button disabled={running} onclick={reencrypt}
        >{running ? "Re-encrypting …" : "Re-encrypt secrets"}</Button
      >
    </div>
  {:else if missing === 0 && waiting === 0}
    <p class="text-muted-foreground text-sm leading-6">
      All stored secrets use the active key version. Keep an earlier version only while a backup you
      may restore still uses it.
    </p>
  {/if}
</div>
