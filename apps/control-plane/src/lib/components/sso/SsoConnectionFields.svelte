<script lang="ts">
  import { oidcProviderInput, type settingsView } from "@platform/contracts";
  import type { z } from "zod";
  import { Checkbox } from "@platform/ui/checkbox";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import { NativeSelect } from "@platform/ui/native-select";
  import { providerConsoles, ssoProviders, type SsoDraft } from "#lib/sso-setup.svelte";
  import ConsoleLink from "./ConsoleLink.svelte";

  let {
    draft = $bindable(),
    view,
    creating,
    domainOptional = false,
  }: {
    draft: SsoDraft;
    view: z.infer<typeof settingsView>;
    creating: boolean;
    domainOptional?: boolean;
  } = $props();

  const issuerHint = $derived(
    draft.sso.appIdentityType === "entra"
      ? "https://login.microsoftonline.com/TENANT-ID/v2.0"
      : "https://login.example.com",
  );
</script>

<div class="space-y-5">
  {#if !creating}
    <div class="space-y-2">
      <Label for="app-identity">Provider</Label>
      <NativeSelect
        id="app-identity"
        value={draft.sso.appIdentityType}
        onchange={(event) => {
          draft.sso.appIdentityType = oidcProviderInput.shape.appIdentityType.parse(
            event.currentTarget.value,
          );
          if (draft.sso.appIdentityType === "google")
            draft.sso.issuer = "https://accounts.google.com";
          if (draft.sso.appIdentityType !== "entra") {
            draft.directory = null;
            draft.embeddingOrigins = [];
          }
        }}
      >
        {#each Object.entries(ssoProviders) as [id, provider] (id)}
          <option value={id}>{provider.label}</option>
        {/each}
      </NativeSelect>
    </div>
  {/if}
  {#if draft.sso.appIdentityType !== "google"}
    <div class="space-y-2">
      <Label for="issuer">Issuer URL</Label>
      <Input
        id="issuer"
        type="url"
        bind:value={draft.sso.issuer}
        placeholder={issuerHint}
        required
      />
    </div>
  {/if}
  <div class="space-y-2">
    <Label for="sso-client">Client ID</Label>
    <Input id="sso-client" bind:value={draft.sso.oidcConfig.clientId} required />
  </div>
  <div class="space-y-2">
    <Label for="sso-secret">Client secret</Label>
    <Input
      id="sso-secret"
      type="password"
      autocomplete="new-password"
      bind:value={draft.sso.oidcConfig.clientSecret}
      required={creating}
      aria-describedby={creating ? undefined : "sso-secret-help"}
    />
    {#if !creating}<p id="sso-secret-help" class="text-muted-foreground text-xs">
        Leave blank to keep the saved secret.
      </p>{/if}
  </div>
  {#if creating}
    <div class="space-y-2">
      <Label for="company-domain"
        >Company email domain{domainOptional ? " (optional)" : ""}</Label
      >
      <Input
        id="company-domain"
        bind:value={draft.sso.domain}
        placeholder="example.com"
        aria-describedby="company-domain-help"
        required={!domainOptional}
      />
      <p id="company-domain-help" class="text-muted-foreground text-xs">
        The part of your members' email addresses after the @. You can add more domains later.
      </p>
    </div>
  {/if}
  <details class="rounded-lg border p-4">
    <summary class="text-sm font-medium">Advanced settings</summary>
    <div class="mt-4 space-y-5">
      <div class="space-y-2">
        <Label for="sso-scopes">OAuth scopes</Label>
        <Input
          id="sso-scopes"
          bind:value={
            () => draft.sso.oidcConfig.scopes.join(" "),
            (value) => {
              draft.sso.oidcConfig.scopes = value.split(/\s/);
            }
          }
          aria-describedby="scopes-help"
        />
        <p id="scopes-help" class="text-muted-foreground text-xs wrap-anywhere">
          Separate scopes with spaces. Keep openid, profile and email for sign-in.
          {#if draft.sso.appIdentityType === "google"}
            For group-based app access, <ConsoleLink href={providerConsoles.googleCloudIdentityApi}
              >enable the Cloud Identity API</ConsoleLink
            > in your Google project and add https://www.googleapis.com/auth/cloud-identity.groups.readonly.
            Each group must let its members view the membership list.
          {/if}
        </p>
      </div>
      <fieldset class="space-y-4">
        <legend class="text-sm font-medium">Claim mappings</legend>
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="name-claim">Name</Label>
            <Input id="name-claim" bind:value={draft.sso.oidcConfig.mapping.name} required />
          </div>
          <div class="space-y-2">
            <Label for="email-claim">Email</Label>
            <Input id="email-claim" bind:value={draft.sso.oidcConfig.mapping.email} required />
          </div>
          {#if draft.sso.appIdentityType === "oidc"}
            <div class="space-y-2">
              <Label for="groups-claim">App groups</Label>
              <Input
                id="groups-claim"
                bind:value={draft.sso.oidcConfig.mapping.extraFields.groups}
                required
              />
            </div>
          {/if}
        </div>
      </fieldset>
      {#if draft.sso.appIdentityType === "entra"}
        <fieldset class="space-y-4">
          <legend class="text-sm font-medium">Directory search</legend>
          <div class="flex items-center gap-3">
            <Checkbox
              id="directory"
              checked={draft.directory !== null}
              onCheckedChange={(enabled) => {
                draft.directory = enabled ? { clientId: "", clientSecret: "" } : null;
              }}
            /><Label for="directory">Connect Microsoft Graph</Label>
          </div>
          {#if draft.directory}
            <p class="text-muted-foreground text-xs">
              Directory search needs the GroupMember.Read.All application permission with
              administrator consent. Grant it under API permissions in <ConsoleLink
                href={providerConsoles.entraAppRegistrations}>App registrations</ConsoleLink
              >.
            </p>
            <div class="space-y-2">
              <Label for="directory-client">Directory client ID</Label>
              <Input id="directory-client" bind:value={draft.directory.clientId} required />
            </div>
            <div class="space-y-2">
              <Label for="directory-secret">Directory client secret</Label>
              <Input
                id="directory-secret"
                type="password"
                bind:value={draft.directory.clientSecret}
                required={!view.settings.directory}
                placeholder={view.settings.directory ? "Leave blank to keep the saved secret" : ""}
                autocomplete="new-password"
              />
            </div>
          {/if}
        </fieldset>
      {/if}
    </div>
  </details>
</div>
