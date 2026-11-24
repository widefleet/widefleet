<script lang="ts">
  import { connectApp, getServiceConnection } from "#lib/services.remote";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "@platform/ui/button";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import { NativeSelect } from "@platform/ui/native-select";
  import { page } from "$app/state";
  import type { PageProps } from "./$types";
  import { getWorkspaceContext } from "#lib/workspace-context";

  const workspace = getWorkspaceContext();

  let { params }: PageProps = $props();

  const data = $derived(
    await getServiceConnection({
      organizationId: workspace.organizationId,
      service: params.service,
      app: page.url.searchParams.get("app"),
    }),
  );

  const path = $derived(workspace.path(`/services/${data.service.appId}/connect`));
</script>

<svelte:head><title>Connect {data.service.displayName} · Widefleet</title></svelte:head>
<div class="max-w-xl space-y-8">
  <a
    class="text-muted-foreground block text-sm underline underline-offset-4"
    href={data.app ? path : workspace.path("/services")}
    >{data.app ? "Back to app selection" : "Back to APIs"}</a
  >
  <nav aria-label="Connection setup" class="text-muted-foreground text-sm">
    <ol class="flex flex-wrap gap-x-6 gap-y-2">
      <li
        aria-current={!data.app ? "step" : undefined}
        class={!data.app ? "text-foreground font-medium" : ""}
      >
        1. Choose app
      </li>
      <li
        aria-current={data.app ? "step" : undefined}
        class={data.app ? "text-foreground font-medium" : ""}
      >
        2. Set up connection
      </li>
      <li>3. Result</li>
    </ol>
  </nav>
  {#if !data.app}
    <PageHeading
      title={`Connect ${data.service.displayName}`}
      description="Which app will use this API?"
    />
    {#if data.applications.length}
      <form method="GET" action={path} class="space-y-6">
        <div class="space-y-2">
          <Label for="consumer-app">Your app</Label>
          <NativeSelect id="consumer-app" name="app" class="w-full" required>
            <option value="">Choose an app you manage</option>
            {#each data.applications as app (app.id)}<option value={app.id}
                >{app.displayName}</option
              >{/each}
          </NativeSelect>
        </div>
        <Button type="submit">Continue</Button>
      </form>
    {:else}
      <p class="text-muted-foreground text-sm">
        You need an app you own or collaborate on before you can connect this API.
      </p>
      <Button href={workspace.path("/apps")}>Go to your apps</Button>
    {/if}
  {:else}
    <PageHeading
      title="Set up your connection"
      description={`${data.app.displayName} will use ${data.service.displayName}.`}
    />
    <p class="text-muted-foreground text-sm leading-6">
      This connection can be saved now. We will show you its activation status next.
    </p>
    <form {...connectApp} class="space-y-6">
      <OrganizationField field={connectApp.fields.organizationId} />
      <input {...connectApp.fields.appId.as("hidden", data.app.id)} />
      <input {...connectApp.fields.targetApp.as("hidden", data.service.appId)} />
      <input {...connectApp.fields.guided.as("hidden", "true")} />
      <div class="space-y-2">
        <Label for="entrypoint">API entrypoint</Label>
        <NativeSelect
          id="entrypoint"
          {...connectApp.fields.entrypoint.as("select")}
          class="w-full"
          required
        >
          {#each data.service.entrypoints as entrypoint (entrypoint)}<option value={entrypoint}
              >{entrypoint}</option
            >{/each}
        </NativeSelect>
      </div>
      <div class="space-y-2">
        <Label for="binding">Binding name in your code</Label>
        <Input
          id="binding"
          {...connectApp.fields.binding.as("text")}
          placeholder="ERP"
          aria-describedby="binding-hint"
          required
        />
        <p id="binding-hint" class="text-muted-foreground text-sm">
          For example, ERP makes this API available as <code>env.ERP</code> in your app.
        </p>
      </div>
      <FormIssues issues={connectApp.fields.allIssues()} />
      <div class="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={connectApp.pending > 0}>Connect API</Button>
        <Button variant="ghost" href={workspace.path(`/apps/${data.app.id}/connections`)}
          >Cancel</Button
        >
      </div>
    </form>
  {/if}
</div>
