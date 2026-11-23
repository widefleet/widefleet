<script lang="ts">
  import FormIssues from "#shadcn/FormIssues.svelte";
  import AuthLayout from "@platform/ui/auth-layout";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { Button } from "@platform/ui/button";
  import { resetClientContext } from "#lib/analytics-client";
  import { createOrganization, joinOrganization } from "#lib/organizations.remote";
  import { Switch } from "@platform/ui/switch";
  import BadgeCheck from "@lucide/svelte/icons/badge-check";
  import { Input } from "@platform/ui/input";
  import * as InputGroup from "@platform/ui/input-group";
  import * as Item from "@platform/ui/item";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { Label } from "@platform/ui/label";
  import { authClient } from "#lib/auth-client";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let message = $state("");

  let pending = $state(false);

  let creating = $state(false);

  const creationIssues = $derived(createOrganization.fields.allIssues());

  let allowDomainJoin = $state(true);

  const joining = $derived(
    data.joinable.some((organization) => joinOrganization.for(organization.id).pending > 0),
  );

  const busy = $derived(pending || joining || createOrganization.pending > 0);

  // The address follows the name until the person edits it.
  let slugEdited = $state(false);

  const slugFor = (name: string) =>
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/, "");

  const hasChoices = $derived(data.organizations.length > 0 || data.joinable.length > 0);

  // Back always returns to the choices. Without choices, the form stays to show why creation
  // failed even once the person can no longer create an organization.
  const showCreation = $derived(
    creating || (!hasChoices && (data.canCreateOrganization || Boolean(creationIssues?.length))),
  );

  // The heading already says what to do; a subtitle only adds scope or a reason.
  const subtitle = $derived(
    data.organizations.length
      ? data.connecting
        ? "Choose the organization whose apps you want to connect."
        : null
      : data.joinable.length
        ? `Your colleagues at ${data.joinable[0]?.domain} already use Widefleet.`
        : data.creationRestricted
          ? `Your company manages Widefleet organizations for ${data.creationRestricted}. Ask one of its administrators for access.`
          : "Your account has no available organizations. Ask your administrator to grant access.",
  );

  // A colleague's name makes the organization recognizable at a glance.
  const describeMembers = (organization: PageData["joinable"][number]) => {
    const [colleague] = organization.colleagues;
    const others = organization.memberCount - 1;

    if (!colleague)
      return `${organization.memberCount} ${organization.memberCount === 1 ? "member" : "members"}`;

    return others ? `${colleague} and ${others} ${others === 1 ? "other" : "others"}` : colleague;
  };

  const signOut = async () => {
    pending = true;
    message = "";

    try {
      const result = await authClient.signOut();

      if (result.error) message = "Could not sign out. Please try again.";
      else {
        resetClientContext();
        window.location.assign("/sign-in");
      }
    } catch {
      message = "Could not sign out. Check your connection.";
    } finally {
      pending = false;
    }
  };
</script>

<svelte:head><title>Choose organization · Widefleet</title></svelte:head>
<AuthLayout class="rounded-xl p-0 sm:p-0">
  <div class="p-6 sm:p-8">
    {#if showCreation}
      {#if hasChoices}
        <Button
          variant="ghost"
          size="sm"
          class="text-muted-foreground mb-5 -ml-2 gap-1.5 px-2 text-xs"
          onclick={() => (creating = false)}
          disabled={busy}
        >
          <ArrowLeft class="size-3.5" />{data.organizations.length
            ? "Back to your organizations"
            : "Back to your team"}
        </Button>
      {/if}
      <h1 class="break-words text-2xl font-semibold leading-tight tracking-tight">
        Create your organization
      </h1>
      <form {...createOrganization} class="mt-6 space-y-5">
        <FormIssues issues={creationIssues} />
        <input {...createOrganization.fields.next.as("hidden", data.next)} />
        <div class="space-y-2">
          <Label for="organization-name">Name</Label><Input
            id="organization-name"
            {...createOrganization.fields.name.as("text")}
            oninput={(event) => {
              if (!slugEdited)
                createOrganization.fields.slug.set(slugFor(event.currentTarget.value));
            }}
            required
            maxlength={200}
            autocomplete="organization"
            class="h-11"
            disabled={busy}
          />
        </div>
        <div class="space-y-2">
          <Label for="organization-slug">URL</Label>
          <InputGroup.Root class="h-11">
            <InputGroup.Addon class="bg-muted/40 h-full border-r pr-3"
              ><InputGroup.Text class="text-base md:text-sm">{data.host}/</InputGroup.Text
              ></InputGroup.Addon
            >
            <InputGroup.Input
              id="organization-slug"
              {...createOrganization.fields.slug.as("text")}
              oninput={() => (slugEdited = true)}
              required
              maxlength={50}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="Lowercase letters, numbers and single hyphens"
              class="pl-3"
              disabled={busy}
            />
          </InputGroup.Root>
        </div>
        {#if data.joinDomain}
          <div class="flex items-center justify-between gap-4 border-t pt-5">
            <Label for="allow-domain-join" class="min-w-0 font-normal leading-5"
              ><span>Enable access for <span class="font-semibold">{data.joinDomain}</span></span
              ></Label
            >
            <Switch
              id="allow-domain-join"
              name={createOrganization.fields.allowDomainJoin.as("checkbox").name}
              bind:checked={allowDomainJoin}
              disabled={busy}
            />
          </div>
        {/if}
        <Button
          type="submit"
          class="bg-foreground text-background hover:bg-foreground/90 h-11 w-full"
          disabled={busy}
          >{createOrganization.pending
            ? "Preparing your organization …"
            : "Create organization"}</Button
        >
      </form>
    {:else}
      <h1 class="break-words text-2xl font-semibold leading-tight tracking-tight">
        {data.organizations.length || !data.joinable.length
          ? "Choose an organization"
          : "Join your team"}
      </h1>
      {#if subtitle}<p class="text-muted-foreground mt-2 text-sm leading-6">{subtitle}</p>{/if}
      {#if data.organizations.length}
        <div class="mt-6 space-y-2.5">
          {#each data.organizations as organization (organization.id)}
            <!-- Choosing only opens the organization; the destination names it in its address. -->
            <Button
              href={organization.ssoRequired
                ? `/sign-in?${new URLSearchParams({ organization: organization.slug, next: organization.destination })}`
                : organization.destination}
              variant="outline"
              class="h-auto min-h-11 w-full justify-between px-4 py-2.5"
            >
              <span class="truncate">{organization.name}</span>
              <span
                class={[
                  "text-muted-foreground text-xs font-normal",
                  !organization.ssoRequired && "capitalize",
                ]}>{organization.ssoRequired ? "Company SSO" : organization.role}</span
              >
            </Button>
          {/each}
        </div>
      {/if}
      {#if data.joinable.length}
        <section class="mt-6" aria-labelledby="joinable-heading">
          {#if data.organizations.length}
            <div class="text-muted-foreground mb-3 flex items-center gap-3 text-xs">
              <div class="bg-border h-px flex-1"></div>
              <h2 id="joinable-heading">Open to {data.joinable[0]?.domain}</h2>
              <div class="bg-border h-px flex-1"></div>
            </div>
          {:else}
            <h2 id="joinable-heading" class="sr-only">Organizations you can join</h2>
          {/if}
          <ul class="space-y-2.5">
            {#each data.joinable as organization (organization.id)}
              {@const join = joinOrganization.for(organization.id)}
              <li>
                <form {...join}>
                  <input {...join.fields.organizationId.as("hidden", organization.id)} />
                  <input {...join.fields.next.as("hidden", data.next)} />
                  <Item.Root variant="outline" class="flex-nowrap gap-4 p-4">
                    <Item.Media
                      class="bg-muted text-foreground hidden size-10 shrink-0 rounded-lg text-sm font-semibold sm:flex"
                      aria-hidden="true">{organization.name.slice(0, 1).toUpperCase()}</Item.Media
                    >
                    <Item.Content class="min-w-0 gap-0.5">
                      <Item.Title class="flex w-full min-w-0 items-center gap-1.5">
                        <span class="truncate">{organization.name}</span>
                        {#if organization.verified}<BadgeCheck
                            class="text-primary size-4 shrink-0"
                            aria-label="Verified"
                          />{/if}
                      </Item.Title>
                      <Item.Description class="truncate text-xs"
                        >{describeMembers(organization)}</Item.Description
                      >
                    </Item.Content>
                    <Item.Actions class="ml-auto shrink-0">
                      <Button
                        type="submit"
                        class="bg-foreground text-background hover:bg-foreground/90 h-9 px-4"
                        disabled={busy}>{join.pending ? "Joining …" : "Join"}</Button
                      >
                    </Item.Actions>
                  </Item.Root>
                  <FormIssues issues={join.fields.allIssues()} />
                </form>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
      {#if data.canCreateOrganization && hasChoices}
        <Button
          variant="outline"
          class="mt-6 h-11 w-full"
          onclick={() => (creating = true)}
          disabled={busy}>Create a new organization</Button
        >
      {/if}
    {/if}
    {#if message}<div class="mt-5"><Feedback kind="error">{message}</Feedback></div>{/if}
  </div>
  <p
    class="bg-muted/20 text-muted-foreground rounded-b-xl border-t px-6 py-4 text-center text-sm sm:px-8"
  >
    <button
      type="button"
      class="text-foreground font-medium underline-offset-4 hover:underline disabled:opacity-50"
      onclick={signOut}
      disabled={busy}>Sign out</button
    >
  </p>
</AuthLayout>
