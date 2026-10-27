<script lang="ts">
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const login = $derived(`widefleet login --url ${JSON.stringify(data.platformUrl)}`);

  const deploy = $derived(`widefleet deploy --organization ${data.organizationId}`);
</script>

<svelte:head><title>Get started · Widefleet</title></svelte:head>
<PageHeading
  title="Publish your first app"
  description="Connect your terminal and deploy an app to your workspace."
/>
<div class="mt-8 max-w-2xl space-y-8">
  {#if data.needsAgent}
    <section class="rounded-lg border p-4 space-y-3">
      <h2 class="font-medium">Connect your deployment agent</h2>
      <p class="text-muted-foreground text-sm">
        This installation needs an enabled deployment agent before it can publish apps. Register the
        agent and start it using the installation guide.
      </p>
      <Button href="/agents" variant="outline">Set up agent</Button>
    </section>
  {/if}
  <section class="space-y-3">
    <h2 class="font-medium">1. Connect the CLI</h2>
    <p class="text-muted-foreground text-sm">
      Install the CLI, then open the login link it prints and approve the request in your browser.
    </p>
    <pre class="bg-muted overflow-x-auto rounded-lg p-4 text-sm"><code
        >pnpm add --global widefleet{"\n"}{login}</code
      ></pre>
  </section>
  <section class="space-y-3">
    <h2 class="font-medium">2. Create and deploy an app</h2>
    <p class="text-muted-foreground text-sm">
      Start with the included SvelteKit template. Deployment prints your app’s address when it is
      ready.
    </p>
    <pre class="bg-muted overflow-x-auto rounded-lg p-4 text-sm"><code
        >widefleet init my-first-app{"\n"}cd my-first-app{"\n"}pnpm install{"\n"}{deploy}</code
      ></pre>
  </section>
  <div class="flex flex-wrap gap-3">
    <Button href="/">Open apps</Button><Button href="/members" variant="outline"
      >Invite your team</Button
    ><Button href="/settings" variant="ghost">Organization settings</Button>
  </div>
  <p class="text-muted-foreground text-sm">
    Company SSO and directory search can be configured later in organization settings. <a
      href="https://widefleet.com/docs/getting-started/installation"
      class="underline underline-offset-4"
      target="_blank"
      rel="noreferrer">Read the app quickstart</a
    >.
  </p>
</div>
