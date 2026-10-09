<script lang="ts">
  import { tick } from "svelte";
  import { getAgents, disableAgent } from "#lib/agents.remote";
  import { registerAgent } from "#lib/apps.remote";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { Badge } from "#shadcn/components/ui/badge/index.js";
  import Server from "@lucide/svelte/icons/server";
  import Plus from "@lucide/svelte/icons/plus";
  import KeyRound from "@lucide/svelte/icons/key-round";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import CopyValue from "#shadcn/components/CopyValue.svelte";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import EmptyState from "#shadcn/components/EmptyState.svelte";

  const agentList = $derived(getAgents());

  const agents = $derived(
    await agentList.catch((cause: unknown) => {
      if (agentList.error && agentList.error.status >= 500 && agentList.current)
        return agentList.current;
      throw cause;
    }),
  );

  let registering = $derived(Boolean(registerAgent.fields.allIssues()?.length));

  let refreshing = $state(false);

  let credentialHeading = $state<HTMLHeadingElement | null>(null);

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;

    try {
      await agentList.refresh();
    } catch {
      // Preserve the one-time credential and confirmed list while the query exposes the error.
    } finally {
      refreshing = false;
    }
  };
</script>

<svelte:head><title>Deployment agents · Widefleet</title></svelte:head>
<PageHeading
  title="Deployment agents"
  description="Agents deploy your apps on your infrastructure."
/>
{#if registerAgent.result?.agentToken}
  <section
    class="mt-7 space-y-4 rounded-xl border border-primary/30 bg-primary/3 p-5"
    role="status"
  >
    <h2
      bind:this={credentialHeading}
      tabindex="-1"
      class="flex items-center gap-2 text-sm font-semibold outline-none"
    >
      <KeyRound class="size-4" />Agent {registerAgent.result.agentName} registered
    </h2>
    <p class="text-muted-foreground text-sm leading-6">
      Save this access key in your agent configuration now. It is only shown once.
    </p>
    <CopyValue value={registerAgent.result.agentToken} label="Copy agent key" secret />
    <p class="text-muted-foreground text-xs">
      Keep this key secure. It allows the agent to receive deployment jobs.
    </p>
  </section>
{/if}
{#if agentList.error}<div class="mt-5 space-y-3">
    <Feedback kind="error"
      >Could not refresh the agent list. The last loaded data and your new access key remain
      visible.</Feedback
    >
    <Button variant="outline" disabled={refreshing} onclick={refresh}>Try again</Button>
  </div>{/if}
<div class="mt-7 overflow-hidden rounded-xl border">
  {#if agents.length === 0}<EmptyState
      title="Your first deployment agent"
      description="Register an agent and add its access key to your deployment host. It can then run deployments."
      >{#snippet icon()}<Server />{/snippet}</EmptyState
    >
  {:else}<ul class="divide-y" aria-label="Deployment agents">
      {#each agents as agent (agent.id)}
        {@const disable = disableAgent.for(agent.id)}
        <li class="p-5">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="flex min-w-0 gap-3">
              <span class="bg-muted grid size-9 shrink-0 place-items-center rounded-lg"
                ><Server class="text-muted-foreground size-4" /></span
              >
              <div class="min-w-0">
                <p class="text-sm font-medium wrap-anywhere">{agent.name}</p>
                <p class="text-muted-foreground mt-1 text-xs">
                  {agent.lastSeenAt
                    ? `Last seen: ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(agent.lastSeenAt))} UTC`
                    : "No contact yet. Start the agent on its host."}
                </p>
              </div>
            </div>
            <Badge variant="secondary">{agent.enabled ? "Registered" : "Disabled"}</Badge>
          </div>
          {#if agent.enabled}<details class="mt-4 pl-12">
              <summary class="text-muted-foreground text-xs">Disable agent</summary>
              <form {...disable} class="mt-3 space-y-3">
                <input {...disable.fields.agentId.as("hidden", agent.id)} />
                <p class="text-muted-foreground text-xs leading-5">
                  This agent will no longer receive new jobs. Make sure another agent is available.
                </p>
                <FormIssues issues={disable.fields.allIssues()} /><Button
                  type="submit"
                  variant="destructive"
                  size="sm"
                  disabled={disable.pending > 0}
                  >{disable.pending ? "Disabling …" : "Confirm deactivation"}</Button
                >
              </form>
            </details>{/if}{#if disable.result?.disabled}<div class="mt-4">
              <Feedback kind="success">Agent disabled.</Feedback>
            </div>{/if}
        </li>
      {/each}
    </ul>{/if}
</div>
<details bind:open={registering} class="mt-6 rounded-xl border p-5 sm:p-6">
  <summary class="flex items-center gap-2 text-sm font-medium"
    ><Plus class="size-4" />Register deployment agent</summary
  >
  <form
    {...registerAgent.enhance(async ({ submit }) => {
      if (await submit()) {
        registering = false;
        await tick();
        credentialHeading?.focus();
        await refresh();
      }
    })}
    class="mt-5 max-w-md space-y-4"
  >
    <FormIssues issues={registerAgent.fields.allIssues()} />
    <div class="space-y-2">
      <Label for="agentName">Agent name</Label><Input
        id="agentName"
        {...registerAgent.fields.name.as("text")}
        placeholder="For example, Deployment Host 01"
        required
        maxlength={120}
      />
      <p class="text-muted-foreground text-xs leading-5">
        A unique name helps you recognize the host later.
      </p>
    </div>
    <Button type="submit" disabled={registerAgent.pending > 0}
      >{registerAgent.pending ? "Registering agent …" : "Register agent"}</Button
    >
  </form>
</details>
