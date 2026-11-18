<script lang="ts">
  import { Button } from "@platform/ui/button";
  import * as Dialog from "@platform/ui/dialog";
  import type { SettingsWriter } from "#lib/sso-setup.svelte";

  let { writer }: { writer: SettingsWriter } = $props();
</script>

<Dialog.Root
  bind:open={writer.restartOpen}
  onOpenChange={(open) => {
    if (!open && !writer.busy) writer.cancel();
  }}
>
  <Dialog.Content
    class="sm:max-w-md"
    showCloseButton={!writer.busy}
    onInteractOutside={(event) => {
      if (writer.busy) event.preventDefault();
    }}
    onEscapeKeydown={(event) => {
      if (writer.busy) event.preventDefault();
    }}
  >
    <Dialog.Header>
      <Dialog.Title>Sign-in service restart required</Dialog.Title>
      <Dialog.Description>
        During the restart, requests to published apps may briefly fail, including for signed-in
        users. Apply this configuration now?
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" disabled={writer.busy} onclick={writer.cancel}>Cancel</Button>
      <Button disabled={writer.busy} onclick={writer.confirm}
        >{writer.busy ? "Applying …" : "Save and restart"}</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
