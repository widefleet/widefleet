<script lang="ts">
  import { Button } from "@platform/ui/button";
  import { Checkbox } from "@platform/ui/checkbox";
  import * as Dialog from "@platform/ui/dialog";
  import { Label } from "@platform/ui/label";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import { z } from "zod";

  let { app }: { app: { id: string; url: string; displayName: string } } = $props();

  // Chrome and Edge on computers install another site's web app with <install>, which
  // they label Launch once it is installed. Pages cannot read whether an app is
  // installed, so this browser remembers the installs it saw and whether to ask.
  // Open app stays a link: Chrome opens it in the installed app's window.
  const promptKey = "widefleet:install-prompt";

  const installedKey = $derived(`widefleet:installed:${app.id}`);

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

  let supported = $state(false);

  let open = $state(false);

  let quiet = $state(false);

  $effect(() => {
    supported = "HTMLInstallElement" in window;
  });

  // The installresult event of <install>.
  const installResult = z.object({ result: z.literal("success") });

  const close = () => {
    if (quiet) write(promptKey, "off");

    open = false;
  };

  const finished = (event: Event) => {
    if (!installResult.safeParse(event).success) return;
    write(installedKey, "installed");
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
    if (!supported || read(promptKey) === "off" || read(installedKey) === "installed") return;
    event.preventDefault();
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
    <Dialog.Header>
      <Dialog.Title>Use {app.displayName} as an app?</Dialog.Title>
      <Dialog.Description>
        Installed apps open in their own window and stay in your Dock or taskbar.
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex items-center gap-2">
      <Checkbox id={`install-prompt-${app.id}`} bind:checked={quiet} /><Label
        for={`install-prompt-${app.id}`}
        class="text-sm">Don't ask again in this browser</Label
      >
    </div>
    <!-- Side by side also on narrow screens: Chrome caps the width of its install button. -->
    <Dialog.Footer class="flex-row justify-end">
      <Button href={app.url} target="_blank" rel="noreferrer" variant="outline" onclick={close}
        >Open in browser</Button
      >
      <install
        {manifest}
        {manifestid}
        oninstallresult={finished}
        class="bg-primary text-primary-foreground h-9 rounded-md px-4 text-sm font-medium"
      ></install>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
