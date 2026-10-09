<script lang="ts">
  import type { Snippet } from "svelte";
  import { page } from "$app/state";
  import { afterNavigate } from "$app/navigation";
  import { mode, setMode } from "mode-watcher";
  import Layers2 from "@lucide/svelte/icons/layers-2";
  import LayoutGrid from "@lucide/svelte/icons/layout-grid";
  import Users from "@lucide/svelte/icons/users";
  import Settings2 from "@lucide/svelte/icons/settings-2";
  import Server from "@lucide/svelte/icons/server";
  import Terminal from "@lucide/svelte/icons/terminal";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import LogOut from "@lucide/svelte/icons/log-out";
  import Sun from "@lucide/svelte/icons/sun";
  import Moon from "@lucide/svelte/icons/moon";
  import Menu from "@lucide/svelte/icons/menu";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import type { Principal } from "#server/identity";
  import { authClient } from "#lib/auth-client";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import * as DropdownMenu from "#shadcn/components/ui/dropdown-menu/index.js";
  import Brand from "./Brand.svelte";
  import Feedback from "./Feedback.svelte";

  let { principal, children }: { principal: Principal; children: Snippet } = $props();

  let signingOut = $state(false);

  let mobileOpen = $state(false);

  let mobileTrigger = $state<HTMLElement | null>(null);

  afterNavigate(() => {
    mobileOpen = false;
  });

  let error = $state("");

  const navigation = [
    { href: "/", label: "All apps", icon: Layers2 },
    { href: "/catalog", label: "App catalog", icon: LayoutGrid },
    { href: "/members", label: "Members", icon: Users },
    { href: "/agents", label: "Deployment agents", icon: Server },
    { href: "/settings", label: "Settings", icon: Settings2 },
  ];

  const active = (href: string) =>
    href === "/"
      ? page.url.pathname === "/" || page.url.pathname.startsWith("/apps/")
      : page.url.pathname.startsWith(href);

  const section = $derived(navigation.find((item) => active(item.href))?.label ?? "Workspace");

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
      else window.location.assign("/sign-in");
    } catch {
      error = "Could not sign out. Check your connection.";
    } finally {
      signingOut = false;
    }
  };
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === "Escape" && mobileOpen) {
      mobileOpen = false;
      mobileTrigger?.focus();
    }
  }}
/>

{#snippet navigationLinks()}
  <nav aria-label="Main navigation" class="space-y-1">
    {#each navigation as item, index (item.href)}
      {#if index < 2 || principal.admin}
        {#if index === 2}<p
            class="text-muted-foreground px-3 pt-7 pb-2 text-[11px] font-medium tracking-wider uppercase"
          >
            Administration
          </p>{/if}
        <a
          href={item.href}
          aria-current={active(item.href) ? "page" : undefined}
          class={`flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors ${active(item.href) ? "bg-sidebar-accent text-foreground font-medium" : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground"}`}
          ><item.icon class="size-4 shrink-0" />{item.label}</a
        >
      {/if}
    {/each}
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
    <a href="/" class="mb-8 px-3" aria-label="Widefleet home"><Brand /></a>
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
                class="text-muted-foreground block text-[11px]"
                >{principal.role === "owner"
                  ? "Owner"
                  : principal.admin
                    ? "Administrator"
                    : "Member"}</span
              ></span
            ><ChevronsUpDown class="text-muted-foreground size-3.5" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="top" align="start" class="w-56">
            <DropdownMenu.Group
              ><DropdownMenu.Label class="truncate">{principal.email}</DropdownMenu.Label
              ><DropdownMenu.Item
                onclick={() => setMode(mode.current === "dark" ? "light" : "dark")}
                >{#if mode.current === "dark"}<Sun />Light appearance{:else}<Moon />Dark appearance{/if}</DropdownMenu.Item
              ></DropdownMenu.Group
            >
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
        <span class="hidden sm:inline">Workspace</span><ChevronRight
          class="hidden size-3 sm:block"
        /><span class="text-foreground">{section}</span>
      </div>
      <span class="text-muted-foreground hidden text-xs md:block">Widefleet</span>
      <details bind:open={mobileOpen} class="group relative md:hidden">
        <summary
          bind:this={mobileTrigger}
          class="text-muted-foreground flex list-none items-center gap-2 rounded-md px-2 py-2 text-xs"
          ><Menu class="size-4" />Menu</summary
        >
        <div class="bg-popover absolute top-11 right-0 z-40 w-64 rounded-xl border p-3 shadow-lg">
          {@render navigationLinks()}
          <div class="mt-3 space-y-1 border-t pt-3">
            <Button href="/device" variant="ghost" class="w-full justify-start"
              ><Terminal />Connect CLI</Button
            ><Button
              variant="ghost"
              class="w-full justify-start"
              onclick={() => setMode(mode.current === "dark" ? "light" : "dark")}
              ><Sun />Toggle appearance</Button
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
