<script lang="ts">
  import AuthLayout from "@platform/ui/auth-layout";
  import Connect from "./Connect.svelte";
  import Unavailable from "./Unavailable.svelte";
  import type { McpPage } from "./pages.ts";
  import styles from "./styles.css?inline";

  let { page, nonce }: { page: McpPage; nonce: string } = $props();

  const titles = {
    connect: "Connect to Widefleet",
    unavailable: "Widefleet sign-in is unavailable",
    error: "Could not connect",
  };
</script>

<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>{titles[page.kind]} · Widefleet</title>
    <!-- Only build-generated CSS is inserted here; account and client data use Svelte's escaping. -->
    <svelte:element this={"style"} {nonce}>{@html styles}</svelte:element>
  </head>
  <body>
    <AuthLayout homeHref={null}>
      <h1 class="text-2xl font-semibold tracking-tight wrap-anywhere">{titles[page.kind]}</h1>
      {#if page.kind === "connect"}<Connect {page} />
      {:else if page.kind === "unavailable"}<Unavailable {page} />
      {:else}<p class="text-muted-foreground mt-3 text-sm leading-relaxed wrap-anywhere">
          {page.message}
        </p>{/if}
    </AuthLayout>
  </body>
</html>
