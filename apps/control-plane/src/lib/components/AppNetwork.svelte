<script lang="ts">
  import { networkChange, networkOrigin } from "@platform/contracts";
  import type { z } from "zod";
  import { toast } from "@platform/ui/sonner";
  import { Badge } from "@platform/ui/badge";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { NativeSelect } from "@platform/ui/native-select";
  import Network from "@lucide/svelte/icons/network";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import { changeAppNetwork, getAppNetwork } from "#lib/network.remote";
  import { failureMessage } from "#lib/sso-setup.svelte";
  import { getWorkspaceContext } from "#lib/workspace-context";
  import CapabilityStatus from "./CapabilityStatus.svelte";

  const workspace = getWorkspaceContext();

  let { appId }: { appId: string } = $props();

  type Target = z.infer<typeof networkChange>["target"];

  type View = Awaited<ReturnType<typeof getAppNetwork>>;

  const request = $derived(getAppNetwork({ organizationId: workspace.organizationId, appId }));

  const view = $derived(
    await request.catch((cause: unknown) => {
      if (request.error && request.error.status >= 500 && request.current) return request.current;
      throw cause;
    }),
  );

  const network = $derived(view.network);

  const targets = ["backend", "browser"] as const satisfies readonly Target[];

  const targetLabels = { backend: "Backend", browser: "Browser" } satisfies Record<Target, string>;

  const rows = (lists: View["network"]["policy"] | undefined) =>
    targets.flatMap((target) => (lists?.[target] ?? []).map((origin) => ({ target, origin })));

  const requested = $derived(rows(network.requested));

  const allowed = $derived(rows(network.policy));

  const undeclared = (target: Target, origin: string) =>
    network.undeclared?.[target].includes(origin) ?? false;

  // Shown only while the lists differ from what the running app enforces.
  const stateHints = {
    saved: "Applies with the first deployment",
    pending: "Applying changes",
    failed: "Could not apply the changes. The previous permissions stay in effect.",
  } satisfies Record<Exclude<View["network"]["state"], "active">, string>;

  // Every origin is HTTPS, so the host alone names it.
  const host = (origin: string) => URL.parse(origin)?.host ?? origin;

  // The lists change at once. The deployment's declaration stays the same, so the requested and
  // no longer declared origins follow from the new lists; the server's answer replaces them all.
  const apply = (current: View, change: z.infer<typeof networkChange>): View => {
    const { target, action, origins } = change;
    const before = current.network.policy[target];
    const after = new Set(before);

    for (const origin of origins)
      if (action === "allow") after.add(origin);
      else after.delete(origin);

    const policy = { ...current.network.policy, [target]: [...after].sort() };

    const declared = (list: Target) => [
      ...current.network.policy[list].filter(
        (origin) => !current.network.undeclared?.[list].includes(origin),
      ),
      ...(current.network.requested?.[list] ?? []),
    ];

    const missing = (wanted: (list: Target) => string[], present: (list: Target) => string[]) => {
      const lacking = (list: Target) =>
        wanted(list).filter((origin) => !present(list).includes(origin));

      return { backend: lacking("backend"), browser: lacking("browser") };
    };

    return {
      ...current,
      network: {
        ...current.network,
        policy,
        ...(current.network.requested && {
          requested: missing(declared, (list) => policy[list]),
          undeclared: missing((list) => policy[list], declared),
        }),
      },
    };
  };

  // Changes reach the server in click order, so the last choice is the one kept.
  let saves = Promise.resolve();

  const change = (input: z.infer<typeof networkChange>, failure: string, restore?: () => void) => {
    // A queued change still belongs to the workspace and app it was made in.
    const { organizationId } = workspace;
    const target = getAppNetwork({ organizationId, appId });
    const override = target.withOverride((current) => apply(current, input));

    saves = saves.then(async () => {
      try {
        await changeAppNetwork({ organizationId, appId, ...input }).updates(override);
      } catch (cause) {
        restore?.();
        toast.error(failure, { description: failureMessage(cause, "Try again.") });
      }
    });
  };

  const allow = (target: Target, origin: string) =>
    change({ target, action: "allow", origins: [origin] }, `Could not allow ${origin}.`);

  const remove = (target: Target, origin: string) =>
    change({ target, action: "deny", origins: [origin] }, `Could not remove ${origin}.`);

  // Repeating an applied change starts the activation again.
  const retry = () => {
    const target = targets.find((list) => network.policy[list].length);

    if (target)
      change(
        { target, action: "allow", origins: network.policy[target] },
        "Could not apply the network permissions again.",
      );
  };

  let adding = $state(false);

  let field = $state<HTMLInputElement | null>(null);

  // Opening the form moves focus to the origin field.
  $effect(() => {
    if (adding) field?.focus();
  });

  let draft = $state("");

  let draftTarget = $state<Target>("backend");

  let draftError = $state("");

  const cancel = () => {
    adding = false;
    draft = "";
    draftError = "";
  };

  const add = (event: SubmitEvent) => {
    event.preventDefault();
    const origin = draft.trim();
    const parsed = networkOrigin.safeParse(origin);

    if (!parsed.success) {
      draftError = parsed.error.issues[0]?.message ?? "Use an exact HTTPS origin.";

      return;
    }

    const target = draftTarget;

    draft = "";
    draftError = "";
    adding = false;
    change({ target, action: "allow", origins: [origin] }, `Could not allow ${origin}.`, () => {
      // Keep what was typed when the server rejects it, unless something new was typed since.
      if (!draft) {
        adding = true;
        draft = origin;
        draftTarget = target;
      }
    });
  };
</script>

{#snippet row(entry: { target: Target; origin: string }, note?: string)}
  <span class="min-w-0 flex-1 text-xs">
    <span class="wrap-anywhere">{host(entry.origin)}</span>
    {#if entry.target === "browser" || note}<span class="text-muted-foreground block"
        >{[entry.target === "browser" ? "Browser" : "", note].filter(Boolean).join(" · ")}</span
      >{/if}
  </span>
{/snippet}

<div class="bg-background rounded-lg border shadow-xs">
  <div class="flex items-center gap-2 border-b px-4 py-4 text-sm font-medium">
    <Network class="text-muted-foreground size-4" />Network permissions<Badge
      variant="secondary"
      class="ml-auto font-normal">{allowed.length}</Badge
    >
  </div>

  {#if requested.length}
    <ul class="divide-y border-b px-4" aria-label="Requested origins">
      {#each requested as entry (`${entry.target} ${entry.origin}`)}
        <li class="flex min-h-12 items-center gap-3 py-2">
          {@render row(entry, "Requested by the app")}
          {#if view.canManage}<Button
              size="xs"
              variant="secondary"
              aria-label={`Allow ${entry.origin} for the ${entry.target}`}
              onclick={() => allow(entry.target, entry.origin)}>Allow</Button
            >{/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if allowed.length}
    <ul class="divide-y px-4" aria-label="Allowed origins">
      {#each allowed as entry (`${entry.target} ${entry.origin}`)}
        <li class="flex min-h-12 items-center gap-3 py-2">
          {@render row(
            entry,
            undeclared(entry.target, entry.origin) ? "No longer requested" : undefined,
          )}
          {#if view.canManage}<Button
              size="icon-xs"
              variant="ghost"
              class="text-muted-foreground"
              aria-label={`Remove ${entry.origin} from the ${entry.target}`}
              onclick={() => remove(entry.target, entry.origin)}><X /></Button
            >{/if}
        </li>
      {/each}
    </ul>
  {:else if !requested.length}
    <div class="px-4 py-6">
      <p class="text-sm">No external origins</p>
      <p class="text-muted-foreground mt-2 text-xs leading-5">
        Requests to other websites and APIs are blocked.
      </p>
    </div>
  {/if}

  {#if view.canManage}
    {#if adding}
      <form class="space-y-2 border-t px-4 py-3" onsubmit={add} novalidate>
        <div class="flex gap-2">
          <Input
            class="h-8 min-w-0 flex-1 text-xs"
            placeholder="https://api.example.com"
            aria-label="Origin to allow"
            autocomplete="off"
            spellcheck={false}
            aria-invalid={draftError ? true : undefined}
            aria-describedby={draftError ? "network-origin-error" : undefined}
            bind:value={draft}
            oninput={() => (draftError = "")}
            onkeydown={(event) => {
              if (event.key === "Escape") cancel();
            }}
            bind:ref={field}
          />
          <NativeSelect
            size="sm"
            class="max-sm:[&_select]:h-8"
            aria-label="Where the app reaches the origin"
            bind:value={draftTarget}
          >
            {#each targets as target (target)}<option value={target}>{targetLabels[target]}</option
              >{/each}
          </NativeSelect>
        </div>
        {#if draftError}<p id="network-origin-error" class="text-destructive text-xs">
            {draftError}
          </p>{/if}
        <div class="flex justify-end gap-2">
          <Button size="xs" variant="ghost" onclick={cancel}>Cancel</Button>
          <Button type="submit" size="xs">Allow</Button>
        </div>
      </form>
    {:else}
      <div class="border-t px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          class="text-muted-foreground w-full justify-start"
          onclick={() => (adding = true)}><Plus />Add origin</Button
        >
      </div>
    {/if}
  {:else}
    <p class="text-muted-foreground border-t px-4 py-3 text-[11px]">
      Only the app’s owner or an administrator can change these.
    </p>
  {/if}

  {#if network.state !== "active"}
    <div class="flex items-center gap-3 border-t px-4 py-3">
      <CapabilityStatus state={network.state} />
      <p class="text-muted-foreground min-w-0 flex-1 text-[11px] leading-4">
        {stateHints[network.state]}{#if network.error}{" "}{network.error}{/if}
      </p>
      {#if network.state === "failed" && view.canManage && allowed.length}<Button
          size="xs"
          variant="outline"
          onclick={retry}>Retry</Button
        >{/if}
    </div>
  {/if}
</div>
