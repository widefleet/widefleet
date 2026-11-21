<script lang="ts">
  import { page } from "$app/state";
  import { Button } from "@platform/ui/button";

  // Deployment agents belong to the installation, so only its administrators see them.
  const tabs = $derived([
    { href: "/settings", label: "Organization" },
    { href: "/members", label: "Members" },
    ...(page.data.principal?.admin ? [{ href: "/agents", label: "Deployment agents" }] : []),
  ]);
</script>

<nav aria-label="Settings" class="mb-7 flex flex-wrap gap-2">
  {#each tabs as tab (tab.href)}
    {@const current = page.url.pathname.startsWith(tab.href)}
    <Button
      href={tab.href}
      variant={current ? "secondary" : "ghost"}
      aria-current={current ? "page" : undefined}>{tab.label}</Button
    >
  {/each}
</nav>
