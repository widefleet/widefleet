<script lang="ts">
  import { Button } from "@platform/ui/button";
  import SocialButton from "@platform/ui/social-button";
  import type { McpPage } from "./pages.ts";

  let { page }: { page: Extract<McpPage, { kind: "connect" }> } = $props();
</script>

<p class="text-muted-foreground mt-3 text-sm leading-relaxed wrap-anywhere">
  <strong class="text-foreground">{page.clientName}</strong> will be able to use the app services available
  to your account.
</p>
<p class="text-muted-foreground mt-3 text-xs leading-relaxed wrap-anywhere">
  Connecting to <strong class="text-foreground">{page.redirectHost}</strong>.
  {#if page.redirectIsLoopback}A local application on your device will receive this connection.{/if}
</p>
<form method="post" action="/oauth/continue" class="mt-6 grid gap-3">
  <input type="hidden" name="handle" value={page.handle} />
  {#each page.accounts as account (account.organizationId)}
    <Button
      type="submit"
      variant="outline"
      name="provider"
      value={`organization:${account.organizationId}`}
      class="h-auto min-h-11 w-full whitespace-normal px-3 py-2.5 wrap-anywhere"
    >
      Continue as {account.name} · {account.organizationName}
    </Button>
  {/each}
  {#if page.providers.length}
    <div class="grid grid-cols-2 gap-2.5">
      {#each page.providers as provider (provider)}
        <div class={page.providers.length === 1 ? "col-span-2" : undefined}>
          <SocialButton {provider} compact type="submit" name="provider" value={provider} />
        </div>
      {/each}
    </div>
  {/if}
  <Button type="submit" variant="outline" name="provider" value="widefleet" class="h-11 w-full">
    Continue with Widefleet
  </Button>
  <Button type="submit" variant="ghost" name="provider" value="cancel" class="h-11 w-full"
    >Cancel</Button
  >
</form>
