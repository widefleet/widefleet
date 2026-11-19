<script lang="ts">
  import { Button } from "@platform/ui/button";
  import type { McpPage } from "./pages.ts";

  let { page }: { page: Extract<McpPage, { kind: "unavailable" }> } = $props();
</script>

<p class="text-muted-foreground mt-3 text-sm leading-relaxed">
  Widefleet sign-in cannot be reached right now. Open one of your organization's Widefleet apps in
  this browser and sign in there. Then check again to continue as that account.
</p>
<div class="mt-6 grid gap-3">
  <Button href={page.authorize} class="h-11 w-full">Check again</Button>
  <form method="post" action="/oauth/continue" class="grid gap-3">
    <input type="hidden" name="handle" value={page.handle} />
    <input type="hidden" name="authorize" value={page.authorize} />
    <input type="hidden" name="confirmed" value="1" />
    {#if page.email}<input type="hidden" name="email" value={page.email} />{/if}
    <Button type="submit" variant="outline" name="provider" value="widefleet" class="h-11 w-full">
      Try Widefleet sign-in anyway
    </Button>
    <Button type="submit" variant="ghost" name="provider" value="cancel" class="h-11 w-full"
      >Cancel</Button
    >
  </form>
</div>
