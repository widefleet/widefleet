<script lang="ts">
  import { afterNavigate } from "$app/navigation";
  import type { z } from "zod";
  import type { userConnectionEntry } from "@platform/contracts";
  import { prepareUserConnection, disconnectUserConnection } from "#lib/user-connections.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import AppIcon from "#shadcn/components/AppIcon.svelte";
  import { Button, buttonVariants } from "@platform/ui/button";
  import Check from "@lucide/svelte/icons/check";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  let {
    connection,
    confirmDisconnect,
    showHostname = false,
  }: {
    connection: z.infer<typeof userConnectionEntry>;
    confirmDisconnect: boolean;
    showHostname?: boolean;
  } = $props();

  const connect = $derived(prepareUserConnection.for(connection.appId));

  const disconnect = $derived(disconnectUserConnection.for(connection.appId));

  let menu = $state<HTMLDetailsElement>();

  afterNavigate(() => {
    if (menu) menu.open = false;
  });

  let previous = $state<z.infer<typeof userConnectionEntry>["status"]>(null);

  $effect(() => {
    if (connection.status) previous = connection.status;
  });

  const status = $derived(connection.status ?? previous);
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape" && menu?.open && menu.contains(document.activeElement)) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  }}
  onpointerdown={(event) => {
    if (menu?.open && event.target instanceof Node && !menu.contains(event.target))
      menu.open = false;
  }}
/>

<li class="py-4" aria-labelledby={`connection-${connection.appId}`}>
  <div class="flex items-center justify-between gap-4">
    <div class="flex min-w-0 items-start gap-3">
      <AppIcon appId={connection.appId} deploymentId={connection.activeDeploymentId} />
      <div class="min-w-0">
        <h2 id={`connection-${connection.appId}`} class="text-sm font-medium wrap-anywhere">
          {connection.displayName}
        </h2>
        {#if showHostname}
          <p class="text-muted-foreground mt-1 text-xs wrap-anywhere">{connection.hostname}</p>
        {/if}
        {#if status?.connection === "connected"}
          <p class="text-muted-foreground mt-1 flex items-start gap-1.5 text-sm">
            <Check aria-hidden="true" class="mt-0.5 size-3.5 shrink-0" />
            <span class="wrap-anywhere">
              {#if connection.unavailable}Last checked:
              {/if}
              {#if status.account}<span class="sr-only">Connected as </span>{status.account.label}
              {:else}Connected{/if}
            </span>
          </p>
        {/if}
        {#if connection.unavailable}
          <p role="status" class="text-muted-foreground mt-1 text-sm">
            Could not check this account.
          </p>
        {:else if status?.setup === "required"}
          <p class="text-muted-foreground mt-1 text-sm">Awaiting administrator setup</p>
        {/if}
      </div>
    </div>
    {#if !connection.unavailable && status?.connection === "connected"}
      <details
        name="connection-actions"
        class="relative shrink-0"
        bind:this={menu}
        onfocusout={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget)
          )
            event.currentTarget.open = false;
        }}
      >
        <summary
          class={buttonVariants({
            variant: "ghost",
            size: "icon",
            class: "text-muted-foreground list-none [&::-webkit-details-marker]:hidden",
          })}
          aria-label={`Account options for ${connection.displayName}`}
          ><Ellipsis aria-hidden="true" /></summary
        >
        <div
          class="bg-popover text-popover-foreground absolute top-full right-0 z-20 mt-1 w-44 rounded-lg border p-1 shadow-md"
        >
          {#if status.setup === "ready"}
            <form {...connect}>
              <OrganizationField field={connect.fields.organizationId} />
              <input {...connect.fields.appId.as("hidden", connection.appId)} />
              <Button
                type="submit"
                variant="ghost"
                class="w-full justify-start"
                disabled={connect.pending > 0}
              >
                {connect.pending > 0 ? "Opening…" : "Reconnect"}<span class="sr-only">
                  {connection.displayName}</span
                >
              </Button>
            </form>
          {/if}
          <Button
            variant="ghost"
            class="w-full justify-start"
            href={workspace.path(`/connections?disconnect=${connection.appId}`)}
          >
            Disconnect<span class="sr-only"> {connection.displayName}</span>
          </Button>
        </div>
      </details>
    {:else if !connection.unavailable && status?.setup === "ready"}
      <form {...connect} class="shrink-0">
        <OrganizationField field={connect.fields.organizationId} />
        <input {...connect.fields.appId.as("hidden", connection.appId)} />
        <Button type="submit" size="sm" variant="outline" disabled={connect.pending > 0}>
          {connect.pending > 0 ? "Opening…" : "Connect"}<span class="sr-only">
            {connection.displayName}</span
          >
        </Button>
      </form>
    {/if}
  </div>
  <FormIssues issues={connect.fields.allIssues()} />
  {#if confirmDisconnect && status?.connection === "connected"}
    <form {...disconnect} class="bg-muted/40 mt-4 space-y-3 rounded-lg p-4">
      <OrganizationField field={disconnect.fields.organizationId} />
      <input {...disconnect.fields.appId.as("hidden", connection.appId)} />
      <p class="text-sm">
        Disconnect your {connection.displayName} account? Apps using this connection will lose access
        until you connect again.
      </p>
      <FormIssues issues={disconnect.fields.allIssues()} />
      <div class="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={disconnect.pending > 0}
          >{disconnect.pending > 0 ? "Disconnecting…" : "Disconnect account"}</Button
        >
        <Button href={workspace.path("/connections")} size="sm" variant="ghost">Cancel</Button>
      </div>
    </form>
  {/if}
</li>
