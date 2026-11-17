<script lang="ts">
  import type { z } from "zod";
  import type { userConnectionEntry } from "@platform/contracts";
  import { prepareUserConnection, disconnectUserConnection } from "#lib/user-connections.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "@platform/ui/button";
  import Check from "@lucide/svelte/icons/check";

  let {
    connection,
    onboarding,
    confirmDisconnect,
  }: {
    connection: z.infer<typeof userConnectionEntry>;
    onboarding: boolean;
    confirmDisconnect: boolean;
  } = $props();

  const connect = $derived(prepareUserConnection.for(connection.appId));

  const disconnect = $derived(disconnectUserConnection.for(connection.appId));

  const path = $derived(onboarding ? "/connections?onboarding=1" : "/connections");

  let previous = $state<z.infer<typeof userConnectionEntry>["status"]>(null);

  $effect(() => {
    if (connection.status) previous = connection.status;
  });

  const status = $derived(connection.status ?? previous);
</script>

<li class="py-5" aria-labelledby={`connection-${connection.appId}`}>
  <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
    <div class="min-w-0 flex-1 basis-56">
      <h2 id={`connection-${connection.appId}`} class="text-sm font-semibold wrap-anywhere">
        {connection.displayName}
      </h2>
      <p class="text-muted-foreground mt-1 text-xs wrap-anywhere">{connection.hostname}</p>
      {#if status?.connection === "connected"}
        <p class="mt-2 flex items-start gap-1.5 text-sm">
          <Check class="mt-0.5 size-4 shrink-0" /><span class="wrap-anywhere"
            >{connection.unavailable ? "Last checked: connected" : "Connected"}{status.account
              ? ` · ${status.account.label}`
              : ""}</span
          >
        </p>
      {:else if !connection.unavailable}
        <p class="text-muted-foreground mt-2 text-sm">Not connected</p>
      {/if}
      {#if connection.unavailable}
        <p role="status" class="text-muted-foreground mt-2 text-sm">
          Status unavailable. Try refreshing; your connection has not been removed.
        </p>
      {:else if status?.setup === "required"}
        <p class="text-muted-foreground mt-2 text-sm">
          Your administrator needs to finish setting up this connector.
        </p>
      {/if}
    </div>
    {#if !connection.unavailable && status?.connection === "connected"}
      <Button
        variant="ghost"
        size="sm"
        href={`${path}${onboarding ? "&" : "?"}disconnect=${connection.appId}`}
        >Disconnect<span class="sr-only"> {connection.displayName}</span></Button
      >
    {:else if !connection.unavailable && status?.setup === "ready"}
      <form {...connect}>
        <OrganizationField field={connect.fields.organizationId} />
        <input {...connect.fields.appId.as("hidden", connection.appId)} />
        <input {...connect.fields.onboarding.as("hidden", String(onboarding))} />
        <Button type="submit" size="sm" disabled={connect.pending > 0}
          >{connect.pending > 0 ? "Opening…" : "Connect"}<span class="sr-only">
            {connection.displayName}</span
          ></Button
        >
      </form>
    {/if}
  </div>
  <FormIssues issues={connect.fields.allIssues()} />
  {#if confirmDisconnect && status?.connection === "connected"}
    <form {...disconnect} class="bg-muted/40 mt-4 space-y-3 rounded-lg p-4">
      <OrganizationField field={disconnect.fields.organizationId} />
      <input {...disconnect.fields.appId.as("hidden", connection.appId)} />
      <input {...disconnect.fields.onboarding.as("hidden", String(onboarding))} />
      <p class="text-sm">
        Disconnect your {connection.displayName} account? Apps using this connection will lose access
        until you connect again.
      </p>
      <FormIssues issues={disconnect.fields.allIssues()} />
      <div class="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={disconnect.pending > 0}
          >{disconnect.pending > 0 ? "Disconnecting…" : "Disconnect account"}</Button
        >
        <Button href={path} size="sm" variant="ghost">Cancel</Button>
      </div>
    </form>
  {/if}
</li>
