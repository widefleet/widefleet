<script lang="ts">
  import { onMount } from "svelte";
  import { isHttpError } from "@sveltejs/kit";
  import { runtimeRelease } from "@platform/contracts";
  import { getRuntimeStatus, installRuntime, rollbackRuntime } from "#lib/runtime-releases.remote";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { NativeSelect } from "#shadcn/components/ui/native-select/index.js";
  import Feedback from "#shadcn/components/Feedback.svelte";

  const query = $derived(getRuntimeStatus());

  const status = $derived(
    await query.catch((cause: unknown) => {
      if (query.error && query.error.status >= 500 && query.current) return query.current;
      throw cause;
    }),
  );

  const pending = $derived(["queued", "running"].includes(status.state));

  let files = $state<FileList>();

  let version = $state("");

  let busy = $state(false);

  let message = $state("");

  const refresh = async () => {
    try {
      await query.refresh();
      message = "";
    } catch {
      message = "Could not refresh runtime status. Check your connection and refresh.";
    }
  };

  const install = async () => {
    const file = files?.[0];

    if (!file) return;
    busy = true;
    message = "";

    try {
      await installRuntime(runtimeRelease.parse(JSON.parse(await file.text())));
    } catch (cause) {
      message = isHttpError(cause)
        ? cause.body.message
        : cause instanceof Error
          ? cause.message
          : "Could not install this runtime release.";
    } finally {
      busy = false;
    }
  };

  const activate = async () => {
    busy = true;
    message = "";

    try {
      await rollbackRuntime({ version });
    } catch (cause) {
      message = isHttpError(cause)
        ? cause.body.message
        : cause instanceof Error
          ? cause.message
          : "Could not activate this runtime version.";
    } finally {
      busy = false;
    }
  };

  onMount(() => {
    let refreshing = false;

    const timer = setInterval(async () => {
      if (!pending || refreshing || document.visibilityState !== "visible") return;
      refreshing = true;

      try {
        await refresh();
      } finally {
        refreshing = false;
      }
    }, 2000);

    return () => clearInterval(timer);
  });
</script>

<section class="max-w-2xl space-y-6 rounded-xl border p-6">
  <div>
    <h2 class="text-base font-semibold">App runtime</h2>
    <p class="text-muted-foreground mt-2 text-sm leading-6">
      Update the runtime shared by all apps and previews in this installation. App code and stored
      data are retained.
    </p>
  </div>
  <dl class="grid grid-cols-2 gap-4 text-sm" aria-live="polite">
    <div>
      <dt class="text-muted-foreground">Active version</dt>
      <dd class="mt-1 font-medium">{status.activeVersion ?? "Not confirmed"}</dd>
    </div>
    <div>
      <dt class="text-muted-foreground">Selected version</dt>
      <dd class="mt-1 font-medium">{status.desiredVersion ?? "None"}</dd>
    </div>
  </dl>
  {#if pending}<Feedback>Activating runtime {status.desiredVersion} …</Feedback>{/if}
  {#if status.message}<Feedback kind={status.state === "failed" ? "error" : "info"}
      >{status.message}</Feedback
    >{/if}
  {#if message}<Feedback kind="error">{message}</Feedback>{/if}
  <Button variant="outline" size="sm" onclick={refresh}>Refresh status</Button>
  <div class="space-y-3 border-t pt-5">
    <Label for="runtime-release">Install a runtime release</Label>
    <p class="text-muted-foreground text-xs leading-6">
      Choose the release.json artifact from a published runtime release.
    </p>
    <Input
      id="runtime-release"
      type="file"
      accept="application/json,.json"
      bind:files
      disabled={busy || pending}
    />
    <Button disabled={busy || pending || !files?.length} onclick={install}
      >Install and activate</Button
    >
  </div>
  {#if status.versions.length}
    <div class="space-y-3 border-t pt-5">
      <Label for="runtime-version">Activate an installed version</Label>
      <NativeSelect id="runtime-version" bind:value={version} disabled={busy || pending}>
        <option value="">Choose a version</option>
        {#each status.versions as installed (installed)}<option value={installed}
            >{installed}</option
          >{/each}
      </NativeSelect>
      <Button variant="outline" disabled={busy || pending || !version} onclick={activate}
        >Activate version</Button
      >
    </div>
  {/if}
</section>
