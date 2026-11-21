<script lang="ts">
  import type { Component, Snippet } from "svelte";
  import { page } from "$app/state";
  import { afterNavigate } from "$app/navigation";
  import House from "@lucide/svelte/icons/house";
  import Layers2 from "@lucide/svelte/icons/layers-2";
  import Link2 from "@lucide/svelte/icons/link-2";
  import Users from "@lucide/svelte/icons/users";
  import Settings2 from "@lucide/svelte/icons/settings-2";
  import Terminal from "@lucide/svelte/icons/terminal";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import LogOut from "@lucide/svelte/icons/log-out";
  import Menu from "@lucide/svelte/icons/menu";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Plus from "@lucide/svelte/icons/plus";
  import type { z } from "zod";
  import type { organizationChoice } from "@platform/contracts";
  import type { Principal } from "#server/identity";
  import { resetClientContext } from "#lib/analytics-client";
  import { authClient } from "#lib/auth-client";
  import { selectOrganization } from "#lib/organizations.remote";
  import { setWorkspaceContext } from "#lib/workspace-context";
  import { Button } from "@platform/ui/button";
  import * as Collapsible from "@platform/ui/collapsible";
  import * as DropdownMenu from "@platform/ui/dropdown-menu";
  import * as Sidebar from "@platform/ui/sidebar";
  import Feedback from "./Feedback.svelte";

  let {
    principal,
    organizations,
    children,
  }: {
    principal: Principal;
    organizations: z.infer<typeof organizationChoice>[];
    children: Snippet;
  } = $props();

  setWorkspaceContext({
    get organizationId() {
      return principal.application.organizationId;
    },
  });

  const organizationName = $derived(
    organizations.find((organization) => organization.id === principal.application.organizationId)
      ?.name ?? "Organization",
  );

  const roleLabel = (role: string) =>
    role === "owner" ? "Owner" : principal.application.admin ? "Administrator" : "Member";

  const forms: Record<string, HTMLFormElement> = $state({});

  let switching = $state(false);

  // Switching mirrors the organization chooser; SSO organizations must sign in first.
  const switchOrganization = (organization: z.infer<typeof organizationChoice>) => {
    if (switching || organization.id === principal.application.organizationId) return;

    if (organization.ssoRequired)
      window.location.assign(
        `/sign-in?${new URLSearchParams({ organization: organization.slug, next: "/" })}`,
      );
    else forms[organization.id]?.requestSubmit();
  };

  const shortcutPrefix = $derived(
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+",
  );

  let signingOut = $state(false);

  let mobileOpen = $state(false);

  let mobileTrigger = $state<HTMLElement | null>(null);

  afterNavigate(() => {
    mobileOpen = false;
  });

  let error = $state("");

  type NavigationItem = {
    href: string;
    label: string;
    icon: Component;
    paths: string[];
    items?: { href: string; label: string; current: (url: typeof page.url) => boolean }[];
  };

  // Each item also covers the pages reached from it, so the sidebar keeps showing where they belong.
  const navigation = $derived<NavigationItem[]>([
    { href: "/", label: "Home", icon: House, paths: [] },
    { href: "/connections", label: "My connections", icon: Link2, paths: ["/connections"] },
    {
      href: "/apps",
      label: "My apps",
      icon: Layers2,
      paths: ["/apps", "/catalog/templates", "/services"],
    },
    ...(principal.application.admin
      ? [
          {
            href: "/settings/company-sign-in",
            label: "Settings",
            icon: Settings2,
            paths: ["/settings"],
            items: [
              {
                href: "/settings/company-sign-in",
                label: "Company sign-in",
                current: (url: typeof page.url) =>
                  url.pathname.startsWith("/settings/company-sign-in"),
              },
              {
                href: "/settings/members",
                label: "Members",
                current: (url: typeof page.url) => url.pathname.startsWith("/settings/members"),
              },
              // Deployment agents belong to the installation, so only its administrators see them.
              ...(principal.admin
                ? [
                    {
                      href: "/settings/agents",
                      label: "Deployment agents",
                      current: (url: typeof page.url) =>
                        url.pathname.startsWith("/settings/agents"),
                    },
                  ]
                : []),
              {
                href: "/settings/administration",
                label: "Administration",
                current: (url: typeof page.url) =>
                  url.pathname.startsWith("/settings/administration"),
              },
            ],
          },
        ]
      : []),
  ]);

  const active = (item: { href: string; paths: string[] }) =>
    item.href === "/"
      ? page.url.pathname === "/"
      : item.paths.some((path) => page.url.pathname.startsWith(path));

  const section = $derived(navigation.find((item) => active(item))?.label ?? "Workspace");

  const initials = $derived(
    principal.name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase(),
  );

  const signOut = async () => {
    signingOut = true;
    error = "";

    try {
      const result = await authClient.signOut();

      if (result.error) error = "Could not sign out. Please try again.";
      else {
        resetClientContext();
        window.location.assign("/sign-in");
      }
    } catch {
      error = "Could not sign out. Check your connection.";
    } finally {
      signingOut = false;
    }
  };
</script>

<svelte:window
  onkeydown={(event) => {
    const position = Number(event.key);

    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      position >= 1 &&
      position <= Math.min(organizations.length, 9)
    ) {
      const organization = organizations[position - 1];

      if (organization) {
        event.preventDefault();
        switchOrganization(organization);
      }
    }

    if (event.key === "Escape" && mobileOpen) {
      mobileOpen = false;
      mobileTrigger?.focus();
    }
  }}
/>

{#snippet navigationLinks()}
  <nav aria-label="Main navigation">
    <Sidebar.Menu class="gap-1">
      {#each navigation as item (item.href)}
        {#if item.items}
          <Collapsible.Root open={active(item)} class="group/collapsible">
            {#snippet child({ props })}
              <Sidebar.MenuItem {...props}>
                <Collapsible.Trigger>
                  {#snippet child({ props })}
                    <Sidebar.MenuButton {...props}
                      ><item.icon /><span>{item.label}</span><ChevronRight
                        class="text-muted-foreground ms-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90 motion-reduce:transition-none"
                      /></Sidebar.MenuButton
                    >
                  {/snippet}
                </Collapsible.Trigger>
                <Collapsible.Content>
                  <Sidebar.MenuSub class="mt-1">
                    {#each item.items as subItem (subItem.href)}
                      {@const current = subItem.current(page.url)}
                      <Sidebar.MenuSubItem>
                        <Sidebar.MenuSubButton
                          href={subItem.href}
                          isActive={current}
                          aria-current={current ? "page" : undefined}
                          ><span>{subItem.label}</span></Sidebar.MenuSubButton
                        >
                      </Sidebar.MenuSubItem>
                    {/each}
                  </Sidebar.MenuSub>
                </Collapsible.Content>
              </Sidebar.MenuItem>
            {/snippet}
          </Collapsible.Root>
        {:else}
          <Sidebar.MenuItem>
            <Sidebar.MenuButton isActive={active(item)}>
              {#snippet child({ props })}
                <a href={item.href} aria-current={active(item) ? "page" : undefined} {...props}
                  ><item.icon /><span>{item.label}</span></a
                >
              {/snippet}
            </Sidebar.MenuButton>
          </Sidebar.MenuItem>
        {/if}
      {/each}
    </Sidebar.Menu>
  </nav>
{/snippet}

<a
  href="#main-content"
  class="bg-primary text-primary-foreground fixed top-2 left-2 z-50 -translate-y-24 rounded-md px-4 py-2 text-sm focus:translate-y-0"
  >Skip to content</a
>
<div
  class="bg-sidebar min-h-svh md:grid md:grid-cols-[224px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)]"
>
  <aside class="sticky top-0 hidden h-svh flex-col px-3 py-5 md:flex">
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={`Choose organization: ${organizationName}`}
        class="hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent mb-6 flex w-full items-center gap-2.5 rounded-md p-2 text-left"
      >
        <span
          class="bg-primary text-primary-foreground grid size-8 shrink-0 place-items-center rounded-lg text-xs font-medium"
          aria-hidden="true">{organizationName.charAt(0).toUpperCase()}</span
        >
        <span class="min-w-0 flex-1"
          ><span class="block truncate text-[13px] font-medium">{organizationName}</span><span
            class="text-muted-foreground block truncate text-[11px]"
            >{roleLabel(principal.role)}</span
          ></span
        >
        <ChevronsUpDown class="text-muted-foreground size-3.5" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="right" align="start" sideOffset={4} class="w-60">
        <DropdownMenu.Group>
          <DropdownMenu.Label class="text-muted-foreground text-xs"
            >Organizations</DropdownMenu.Label
          >
          {#each organizations as organization, index (organization.id)}
            <DropdownMenu.Item
              disabled={switching}
              onSelect={() => switchOrganization(organization)}
              class="gap-2 p-2"
            >
              <span
                class="grid size-6 shrink-0 place-items-center rounded-md border text-[11px] font-medium"
                aria-hidden="true">{organization.name.charAt(0).toUpperCase()}</span
              >
              <span class="min-w-0 flex-1 truncate">{organization.name}</span>
              {#if index < 9}<DropdownMenu.Shortcut
                  >{shortcutPrefix}{index + 1}</DropdownMenu.Shortcut
                >{/if}
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Item class="gap-2 p-2">
          {#snippet child({ props })}<a {...props} href="/organizations"
              ><span
                class="bg-background grid size-6 place-items-center rounded-md border"
                aria-hidden="true"><Plus class="size-4" /></span
              ><span class="text-muted-foreground font-medium">Add organization</span></a
            >{/snippet}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    {#each organizations as organization (organization.id)}
      {@const selection = selectOrganization.for(organization.id)}
      <form
        bind:this={forms[organization.id]}
        hidden
        {...selection.enhance(async ({ submit }) => {
          switching = true;
          error = "";
          try {
            await submit();
            // A full navigation drops cached queries and forms from the previous organization.
            if (selection.result?.selected) window.location.assign(selection.result.next);
          } catch {
            error = "Could not switch organization. Refresh the page and try again.";
          } finally {
            switching = false;
          }
        })}
      >
        <input {...selection.fields.organizationId.as("hidden", organization.id)} />
        <input {...selection.fields.next.as("hidden", "/")} />
      </form>
    {/each}
    {@render navigationLinks()}
    <div class="mt-auto space-y-3 pt-8">
      <a
        href="/device"
        class="text-muted-foreground hover:text-foreground hover:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px]"
        ><Terminal class="size-4" />Connect CLI</a
      >
      <div class="border-t pt-3">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="hover:bg-sidebar-accent flex w-full items-center gap-2.5 rounded-md p-2 text-left"
            aria-label={`Account: ${principal.name}`}
          >
            <span
              class="bg-background grid size-8 shrink-0 place-items-center rounded-lg border text-xs font-medium"
              >{initials}</span
            >
            <span class="min-w-0 flex-1"
              ><span class="block truncate text-xs font-medium">{principal.name}</span><span
                class="text-muted-foreground block text-[11px]">{roleLabel(principal.role)}</span
              ></span
            ><ChevronsUpDown class="text-muted-foreground size-3.5" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="top" align="start" class="w-56">
            <DropdownMenu.Group
              ><DropdownMenu.Label class="truncate">{principal.email}</DropdownMenu.Label
              ></DropdownMenu.Group
            >
            <DropdownMenu.Item>
              {#snippet child({ props })}<a {...props} href="/account"><Users />Your account</a
                >{/snippet}
            </DropdownMenu.Item>
            <DropdownMenu.Separator /><DropdownMenu.Item disabled={signingOut} onclick={signOut}
              ><LogOut />{signingOut ? "Signing out …" : "Sign out"}</DropdownMenu.Item
            >
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
  </aside>
  <div
    class="bg-background min-h-svh min-w-0 md:my-2 md:mr-2 md:min-h-[calc(100svh-1rem)] md:rounded-xl md:border md:shadow-xs"
  >
    <header class="flex min-h-14 items-center justify-between gap-4 border-b px-5 sm:px-8">
      <div class="text-muted-foreground flex items-center gap-2 text-xs">
        <a
          href="/organizations"
          aria-label={`Choose organization: ${organizationName}`}
          class="hover:text-foreground max-w-40 truncate md:hidden">{organizationName}</a
        ><ChevronRight class="hidden size-3 sm:block md:hidden" /><span class="text-foreground"
          >{section}</span
        >
      </div>
      <details bind:open={mobileOpen} class="group relative md:hidden">
        <summary
          bind:this={mobileTrigger}
          class="text-muted-foreground flex list-none items-center gap-2 rounded-md px-2 py-2 text-xs"
          ><Menu class="size-4" />Menu</summary
        >
        <div class="bg-popover absolute top-11 right-0 z-40 w-64 rounded-xl border p-3 shadow-lg">
          {@render navigationLinks()}
          <div class="mt-3 space-y-1 border-t pt-3">
            <Button href="/account" variant="ghost" class="w-full justify-start"
              ><Users />Your account</Button
            >
            <Button href="/device" variant="ghost" class="w-full justify-start"
              ><Terminal />Connect CLI</Button
            ><Button
              variant="ghost"
              class="w-full justify-start"
              disabled={signingOut}
              onclick={signOut}><LogOut />Sign out</Button
            >
          </div>
        </div>
      </details>
    </header>
    <main
      id="main-content"
      class="mx-auto max-w-6xl px-5 py-8 sm:px-8 lg:px-12 lg:py-10"
      tabindex="-1"
    >
      {#if error}<div class="mb-6"><Feedback kind="error">{error}</Feedback></div>{/if}
      {@render children()}
    </main>
  </div>
</div>
