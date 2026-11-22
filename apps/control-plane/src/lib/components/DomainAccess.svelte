<script lang="ts">
  import { isHttpError } from "@sveltejs/kit";
  import AtSign from "@lucide/svelte/icons/at-sign";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash from "@lucide/svelte/icons/trash-2";
  import {
    addJoinDomain,
    getDomainAccess,
    removeJoinDomain,
    restrictOrganizationCreation,
  } from "#lib/domain-access.remote";
  import { Button } from "@platform/ui/button";
  import { Label } from "@platform/ui/label";
  import { Switch } from "@platform/ui/switch";
  import Feedback from "./Feedback.svelte";

  let { organizationId }: { organizationId: string } = $props();

  const access = $derived(await getDomainAccess({ organizationId }));

  const offered = $derived(
    access?.provableDomains.filter((domain) => !access.joinDomains.includes(domain)) ?? [],
  );

  let error = $state("");

  // One change at a time, so saves reach the server in click order.
  const saving = $derived(
    addJoinDomain.pending + removeJoinDomain.pending + restrictOrganizationCreation.pending > 0,
  );

  const failure = (cause: unknown, fallback: string) =>
    isHttpError(cause) ? cause.body.message : cause instanceof Error ? cause.message : fallback;

  // The list changes at once. The server's answer replaces the change; a failure restores it.
  const optimistic = (
    update: (current: NonNullable<typeof access>) => NonNullable<typeof access>,
  ) => getDomainAccess({ organizationId }).withOverride((current) => current && update(current));

  const run = async (operation: Promise<unknown>, fallback: string) => {
    error = "";

    try {
      await operation;
    } catch (cause) {
      error = failure(cause, fallback);
    }
  };

  const add = (domain: string) =>
    run(
      addJoinDomain({ organizationId, domain }).updates(
        optimistic((current) => ({ ...current, joinDomains: [...current.joinDomains, domain] })),
      ),
      "The domain could not be added.",
    );

  const remove = (domain: string) =>
    run(
      removeJoinDomain({ organizationId, domain }).updates(
        optimistic((current) => ({
          ...current,
          joinDomains: current.joinDomains.filter((entry) => entry !== domain),
        })),
      ),
      "The domain could not be removed.",
    );

  const restrict = (restricted: boolean) =>
    run(
      restrictOrganizationCreation({ organizationId, restricted }).updates(
        optimistic((current) => ({ ...current, restrictOrganizationCreation: restricted })),
      ),
      "The setting could not be saved.",
    );
</script>

{#if access}
  <section class="mt-10 border-t pt-6" aria-labelledby="domain-access-heading">
    <h2 id="domain-access-heading" class="text-sm font-medium">Join by email domain</h2>
    <p class="text-muted-foreground mt-1 text-sm">
      People with a verified address on these domains can join as members without an invitation.
    </p>
    {#if error}<div class="mt-4"><Feedback kind="error">{error}</Feedback></div>{/if}
    {#if access.joinDomains.length}
      <ul class="mt-3 divide-y" aria-label="Join domains">
        {#each access.joinDomains as domain (domain)}
          <li class="flex items-center justify-between gap-3 py-3">
            <span class="flex min-w-0 items-center gap-2 text-sm"
              ><AtSign class="text-muted-foreground size-4 shrink-0" /><span class="truncate"
                >{domain}</span
              ></span
            >
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Stop letting ${domain} addresses join`}
              disabled={saving}
              onclick={() => remove(domain)}><Trash />Remove</Button
            >
          </li>
        {/each}
      </ul>
    {/if}
    {#each offered as domain (domain)}
      <Button variant="outline" size="sm" class="mt-3" disabled={saving} onclick={() => add(domain)}
        ><Plus />Let anyone with a @{domain} address join</Button
      >
    {:else}
      {#if !access.joinDomains.length}
        <p class="text-muted-foreground mt-3 text-xs leading-5">
          Sign in with Google Workspace or a Microsoft work account to let colleagues on your
          company domain join.
        </p>
      {/if}
    {/each}
    {#if access.verifiedDomains.length}
      <div class="mt-6 flex items-start justify-between gap-4 rounded-lg border p-4">
        <div class="space-y-1">
          <Label for="restrict-organization-creation" class="text-sm font-medium"
            >Reserve new organizations for administrators</Label
          >
          <p class="text-muted-foreground text-xs leading-5">
            Only owners and admins of this organization can create organizations with
            {access.verifiedDomains.map((domain) => `@${domain}`).join(", ")} addresses, and only this
            organization can let these addresses join. Existing organizations are unaffected.
          </p>
        </div>
        <Switch
          id="restrict-organization-creation"
          checked={access.restrictOrganizationCreation}
          disabled={saving}
          onCheckedChange={restrict}
        />
      </div>
    {/if}
  </section>
{/if}
