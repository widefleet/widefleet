<script lang="ts">
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import type { McpPage } from "./pages.ts";

  let { page }: { page: Extract<McpPage, { kind: "connect" }> } = $props();

  // A known organization is the likely choice; otherwise the email continues.
  const known = $derived(page.accounts.length + page.organizations.length > 0);
</script>

<p class="text-muted-foreground mt-3 text-sm leading-relaxed wrap-anywhere">
  <strong class="text-foreground">{page.clientName}</strong> will be able to use the app services available
  to your account.
</p>
<p class="text-muted-foreground mt-3 text-xs leading-relaxed wrap-anywhere">
  Connecting to <strong class="text-foreground">{page.redirectHost}</strong>.
  {#if page.redirectIsLoopback}A local application on your device will receive this connection.{/if}
</p>
{#snippet organization(id: string, name: string, detail: string, primary: boolean)}
  <Button
    type="submit"
    variant={primary ? "default" : "outline"}
    name="provider"
    value={`organization:${id}`}
    class="h-auto min-h-11 w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left whitespace-normal wrap-anywhere"
  >
    <span class="font-medium">{name}</span>
    <span class="text-xs font-normal opacity-75">{detail}</span>
  </Button>
{/snippet}

{#if known}
  <form method="post" action="/oauth/continue" class="mt-6 grid gap-3">
    <input type="hidden" name="handle" value={page.handle} />
    <input type="hidden" name="authorize" value={page.authorize} />
    {#each page.accounts as account, index (account.organizationId)}
      {@render organization(
        account.organizationId,
        account.organizationName,
        `Signed in as ${account.name}`,
        index === 0,
      )}
    {/each}
    {#each page.organizations as remembered, index (remembered.id)}
      {@render organization(
        remembered.id,
        remembered.name,
        "Connected before",
        page.accounts.length === 0 && index === 0,
      )}
    {/each}
  </form>
{/if}
{#if known}
  <!-- Same divider as the control plane's sign-in page. -->
  <div class="text-muted-foreground mt-6 flex items-center gap-3 text-xs">
    <div class="bg-border h-px flex-1"></div>
    or use another organization
    <div class="bg-border h-px flex-1"></div>
  </div>
{/if}
<form method="post" action="/oauth/continue" class="mt-6 grid gap-2">
  <input type="hidden" name="handle" value={page.handle} />
  <input type="hidden" name="authorize" value={page.authorize} />
  <Label for="email">Work email</Label>
  <Input id="email" type="email" name="email" autocomplete="email" required maxlength={320} />
  <Button
    type="submit"
    variant={known ? "outline" : "default"}
    name="provider"
    value="email"
    class="mt-1 h-11 w-full"
  >
    Continue with email
  </Button>
</form>
<form method="post" action="/oauth/continue" class="mt-3 grid gap-3">
  <input type="hidden" name="handle" value={page.handle} />
  <input type="hidden" name="authorize" value={page.authorize} />
  <Button type="submit" variant="outline" name="provider" value="widefleet" class="h-11 w-full">
    Continue with Widefleet
  </Button>
  <Button type="submit" variant="ghost" name="provider" value="cancel" class="h-11 w-full"
    >Cancel</Button
  >
</form>
