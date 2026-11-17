<script lang="ts">
  import { Button, type ButtonProps } from "./components/ui/button/index.ts";
  import google from "./assets/google.svg?inline";
  import microsoft from "./assets/microsoft.svg?inline";

  let {
    provider,
    compact = false,
    busy = false,
    children,
    ...props
  }: ButtonProps & {
    provider: "google" | "microsoft";
    compact?: boolean;
    busy?: boolean;
  } = $props();

  const labels = { google: "Google", microsoft: "Microsoft" };
</script>

<Button
  variant="outline"
  class={compact ? "h-11 w-full gap-2 px-2 text-sm" : "h-10 w-full"}
  aria-label={`Continue with ${labels[provider]}`}
  {...props}
>
  <img
    src={provider === "google" ? google : microsoft}
    class="size-4"
    width="16"
    height="16"
    alt=""
  />
  {busy
    ? compact
      ? "Opening …"
      : "Opening sign-in …"
    : `${compact ? "" : "Continue with "}${labels[provider]}`}
  {@render children?.()}
</Button>
