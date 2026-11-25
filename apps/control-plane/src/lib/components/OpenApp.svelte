<script lang="ts">
  import { Button } from "@platform/ui/button";
  import { Checkbox } from "@platform/ui/checkbox";
  import * as Dialog from "@platform/ui/dialog";
  import { Label } from "@platform/ui/label";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import Menu from "@lucide/svelte/icons/menu";
  import Share from "@lucide/svelte/icons/share";
  import SquarePlus from "@lucide/svelte/icons/square-plus";
  import { z } from "zod";

  let { app }: { app: { id: string; url: string; displayName: string } } = $props();

  // Chrome and Edge on computers install another site's web app with <install>, which
  // they label Launch once it is installed. iPhone and iPad offer no way to install
  // from a page, so they get the steps once per app. Pages cannot read whether an app
  // is installed, so this browser remembers what it saw and whether to ask.
  // Open app stays a link: Chrome opens it in the installed app's window.
  const promptKey = "widefleet:install-prompt";

  const appKey = $derived(`widefleet:install:${app.id}`);

  const read = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const write = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Without storage, the browser asks again next time.
    }
  };

  let way = $state<"install" | "iPhone" | "iPad" | null>(null);

  let open = $state(false);

  let quiet = $state(false);

  $effect(() => {
    // iPadOS reports itself as a Mac; touch tells it apart from Safari on a Mac.
    if ("HTMLInstallElement" in window) way = "install";
    else if ("standalone" in navigator && navigator.maxTouchPoints > 1)
      way = navigator.userAgent.includes("iPhone") ? "iPhone" : "iPad";
  });

  // The installresult event of <install>.
  const installResult = z.object({ result: z.literal("success") });

  const close = () => {
    if (quiet) write(promptKey, "off");

    open = false;
  };

  const finished = (event: Event) => {
    if (!installResult.safeParse(event).success) return;
    write(appKey, "installed");
    open = false;
  };

  const manifest = $derived(new URL("/manifest.webmanifest", app.url).href);

  const manifestid = $derived(new URL("/", app.url).href);
</script>

<Button
  href={app.url}
  target="_blank"
  rel="noreferrer"
  variant="ghost"
  size="sm"
  onclick={(event: MouseEvent) => {
    // Read on each click: another card may have turned the question off.
    if (!way || read(promptKey) === "off" || read(appKey) !== null) return;
    event.preventDefault();
    if (way !== "install") write(appKey, "hinted");
    open = true;
  }}>Open app<ArrowUpRight /><span class="sr-only"> {app.displayName} in a new tab</span></Button
>

<Dialog.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) close();
  }}
>
  <Dialog.Content class="sm:max-w-md">
    {#if way !== "install"}
      <Dialog.Header>
        <Dialog.Title>Add {app.displayName} to your {way}?</Dialog.Title>
        <Dialog.Description
          >Then you can open {app.displayName} straight from its icon.</Dialog.Description
        >
      </Dialog.Header>
      <div class="grid gap-3 text-sm">
        <p class="font-medium">In {app.displayName}:</p>
        <ol class="grid gap-3">
          {#each [{ text: "Tap the menu next to the address bar", Icon: Menu }, { text: "Tap Share", Icon: Share }, { text: "Tap “View More”" }, { text: "Tap “Add to Home Screen”", Icon: SquarePlus }, { text: "Tap “Add”" }] as step, index (step.text)}
            <li class="flex items-center gap-3">
              <span
                class="bg-muted text-muted-foreground grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium"
                >{index + 1}</span
              >{step.text}{#if step.Icon}<step.Icon class="text-muted-foreground size-4" />{/if}
            </li>
          {/each}
        </ol>
      </div>
    {:else}
      <Dialog.Header>
        <Dialog.Title>Use {app.displayName} as an app?</Dialog.Title>
        <Dialog.Description>
          Installed apps open in their own window and stay in your Dock or taskbar.
        </Dialog.Description>
      </Dialog.Header>
    {/if}
    <div class="flex items-center gap-2">
      <Checkbox id={`install-prompt-${app.id}`} bind:checked={quiet} /><Label
        for={`install-prompt-${app.id}`}
        class="text-sm">Don't ask again in this browser</Label
      >
    </div>
    <!-- Side by side also on narrow screens: Chrome caps the width of its install button. -->
    <Dialog.Footer class="flex-row justify-end">
      {#if way !== "install"}
        <Button href={app.url} target="_blank" rel="noreferrer" onclick={close}
          >Continue to {app.displayName}</Button
        >
      {:else}
        <Button href={app.url} target="_blank" rel="noreferrer" variant="outline" onclick={close}
          >Open in browser</Button
        >
        <install
          {manifest}
          {manifestid}
          oninstallresult={finished}
          class="bg-primary text-primary-foreground h-9 rounded-md px-4 text-sm font-medium"
        ></install>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
