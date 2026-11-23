<script lang="ts">
  import {
    getAppServices,
    getConnectionRequests,
    decideConnectionRequest,
  } from "#lib/services.remote";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import AppApisHeader from "#shadcn/components/AppApisHeader.svelte";
  import { Button } from "@platform/ui/button";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  const catalog = $derived(await getAppServices({ organizationId: workspace.organizationId }));

  const requests = $derived(
    await getConnectionRequests({ organizationId: workspace.organizationId }),
  );

  const statuses = [
    { status: "pending", label: "Awaiting approval", dot: "bg-amber-500" },
    { status: "approved", label: "Approved", dot: "bg-emerald-500" },
    { status: "rejected", label: "Rejected", dot: "bg-muted-foreground/50" },
  ] as const;

  const groups = $derived(
    statuses.flatMap((group) => {
      const entries = requests.entries.filter((entry) => entry.status === group.status);

      return entries.length ? [{ ...group, entries }] : [];
    }),
  );

  const dates = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

  const initials = (name: string) =>
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toLocaleUpperCase("en"))
      .join("");
</script>

<svelte:head><title>Connection requests · Widefleet</title></svelte:head>
<AppApisHeader
  active="requests"
  apis={catalog.entries.length}
  pending={groups.find((group) => group.status === "pending")?.entries.length ?? 0}
/>
{#each groups as group (group.status)}
  <section aria-label={group.label} class="mt-6">
    <h2 class="text-muted-foreground flex items-center gap-2 px-3 pb-2 text-xs font-medium">
      <span class={`size-1.5 rounded-full ${group.dot}`} aria-hidden="true"
      ></span>{group.label}<span class="tabular-nums">{group.entries.length}</span>
    </h2>
    <ul class="divide-y border-y">
      {#each group.entries as entry (entry.id)}
        {@const decide = requests.admin && entry.status === "pending"}
        <li
          aria-label={`${entry.appName} to ${entry.serviceName}`}
          class="group hover:bg-muted/40 relative flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5"
        >
          <div class="flex min-w-0 flex-[1_1_16rem] items-center gap-3">
            <span class={`size-2 shrink-0 rounded-full ${group.dot}`} aria-hidden="true"></span>
            <div class="min-w-0">
              <p class="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <a
                  href={workspace.path(`/apps/${entry.appId}/connections`)}
                  class="truncate after:absolute after:inset-0"
                  >{entry.appName}<span class="sr-only"> connections</span></a
                ><span class="text-muted-foreground shrink-0" aria-hidden="true">→</span><span
                  class="truncate">{entry.serviceName}</span
                ><span class="sr-only">, {group.label}</span>
              </p>
              <p class="text-muted-foreground truncate font-mono text-xs">
                {entry.binding} · {entry.entrypoint}
              </p>
            </div>
          </div>
          {#if requests.admin}<span
              class="text-muted-foreground hidden items-center gap-2 text-xs md:inline-flex"
              ><span
                class="bg-muted text-foreground grid size-5 place-items-center rounded-full text-[9px] font-semibold"
                aria-hidden="true">{initials(entry.requesterName)}</span
              >{entry.requesterName}</span
            >{/if}
          <time
            class="text-muted-foreground w-14 text-right text-xs tabular-nums"
            datetime={entry.createdAt}>{dates.format(new Date(entry.createdAt))}</time
          >
          {#if decide}
            {@const decision = decideConnectionRequest.for(entry.id)}
            <form {...decision} class="relative z-10 flex items-center gap-2">
              <OrganizationField field={decision.fields.organizationId} />
              <input {...decision.fields.requestId.as("hidden", entry.id)} />
              <Button
                size="sm"
                variant="ghost"
                {...decision.fields.decision.as("submit", "reject")}
                disabled={decision.pending > 0}>Reject</Button
              >
              <Button
                size="sm"
                {...decision.fields.decision.as("submit", "approve")}
                disabled={decision.pending > 0}>Approve and connect</Button
              >
            </form>
            {#if decision.fields.allIssues()?.length}<div class="basis-full">
                <FormIssues issues={decision.fields.allIssues()} />
              </div>{/if}
          {:else}
            <ChevronRight class="text-muted-foreground/50 group-hover:text-foreground size-4" />
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{:else}
  <p class="text-muted-foreground py-10 text-center text-sm">No connection requests yet.</p>
{/each}
