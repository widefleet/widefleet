<script lang="ts">
  import { connectApp, requestAppConnection } from "#lib/services.remote";
  import PageHeading from "#shadcn/components/PageHeading.svelte";
  import OrganizationField from "#shadcn/OrganizationField.svelte";
  import FormIssues from "#shadcn/FormIssues.svelte";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Input } from "#shadcn/components/ui/input/index.js";
  import { Label } from "#shadcn/components/ui/label/index.js";
  import { NativeSelect } from "#shadcn/components/ui/native-select/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const path = $derived(`/services/${data.service.appId}/connect`);

  const action = $derived(data.approval ? requestAppConnection : connectApp);
</script>

<svelte:head><title>Connect {data.service.displayName} · Widefleet</title></svelte:head>
<div class="max-w-xl space-y-8">
  <a
    class="text-muted-foreground block text-sm underline underline-offset-4"
    href={data.app ? path : "/services"}>{data.app ? "Back to app selection" : "Back to APIs"}</a
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
      <Button href="/">Go to your apps</Button>
    {/if}
  {:else}
    <PageHeading
      title={data.approval ? "Request a connection" : "Set up your connection"}
      description={`${data.app.displayName} will use ${data.service.displayName}.`}
    />
    <p class="text-muted-foreground text-sm leading-6">
      {data.approval
        ? "An organization administrator must approve this connection. Submitting the request does not give your app access yet."
        : "This connection can be saved now. We will show you its activation status next."}
    </p>
    <form {...action} class="space-y-6">
      <OrganizationField field={action.fields.organizationId} />
      <input {...action.fields.appId.as("hidden", data.app.id)} />
      <input {...action.fields.targetApp.as("hidden", data.service.appId)} />
      {#if !data.approval}<input {...connectApp.fields.guided.as("hidden", "true")} />{/if}
      <div class="space-y-2">
        <Label for="entrypoint">API entrypoint</Label>
        <NativeSelect
          id="entrypoint"
          {...action.fields.entrypoint.as("select")}
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
          {...action.fields.binding.as("text")}
          placeholder="ERP"
          aria-describedby="binding-hint"
          required
        />
        <p id="binding-hint" class="text-muted-foreground text-sm">
          For example, ERP makes this API available as <code>env.ERP</code> in your app.
        </p>
      </div>
      <FormIssues issues={action.fields.allIssues()} />
      <div class="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={action.pending > 0}
          >{data.approval ? "Submit request" : "Connect API"}</Button
        >
        <Button variant="ghost" href={`/apps/${data.app.id}/connections`}>Cancel</Button>
      </div>
    </form>
  {/if}
</div>
