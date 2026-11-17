<script lang="ts">
  import { Button } from "@platform/ui/button";
  import type { McpPage } from "./pages.ts";

  let { page }: { page: Extract<McpPage, { kind: "organizations" }> } = $props();
</script>

<p class="text-muted-foreground mt-3 text-sm leading-relaxed">
  Your company account can connect to these organizations.
</p>
<form method="post" action="/oauth/select" class="mt-6 grid gap-3">
  <input type="hidden" name="state" value={page.state} />
  {#each page.organizations as organization (organization.id)}
    <Button
      type="submit"
      variant="outline"
      name="organization"
      value={organization.id}
      class="h-auto min-h-11 w-full whitespace-normal px-3 py-2.5 wrap-anywhere"
    >
      {organization.name}
    </Button>
  {/each}
</form>
