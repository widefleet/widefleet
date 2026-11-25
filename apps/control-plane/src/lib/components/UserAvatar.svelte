<script lang="ts">
  import * as Avatar from "@platform/ui/avatar";
  import { cn } from "@platform/ui/utils";

  let {
    name,
    image,
    class: className,
  }: { name: string; image: string | null; class?: string } = $props();

  const initials = $derived(
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase(),
  );
</script>

<!-- The name is always shown next to the picture, so the picture itself is decorative. -->
<Avatar.Root class={cn("after:rounded-[inherit]", className)}>
  {#if image}
    <!-- The sign-in provider hosts the picture and need not learn which page shows it.
         Google's picture host can also refuse requests with another site's referrer. -->
    <Avatar.Image src={image} alt="" referrerpolicy="no-referrer" class="rounded-[inherit]" />
  {/if}
  <Avatar.Fallback class="rounded-[inherit] text-xs font-medium">{initials}</Avatar.Fallback>
</Avatar.Root>
