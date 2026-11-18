<script lang="ts">
  import { isHttpError } from "@sveltejs/kit";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import Globe from "@lucide/svelte/icons/globe";
  import Trash from "@lucide/svelte/icons/trash-2";
  import { companyDomain, type ssoDomain } from "@platform/contracts";
  import type { z } from "zod";
  import { addCompanyDomain, removeCompanyDomain, verifyCompanyDomain } from "#lib/settings.remote";
  import { Button } from "@platform/ui/button";
  import * as Dialog from "@platform/ui/dialog";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import DnsRecord from "./DnsRecord.svelte";
  import StatusBadge from "./StatusBadge.svelte";
  import EmptyState from "./EmptyState.svelte";
  import Feedback from "./Feedback.svelte";

  let {
    domains,
    organizationId,
    readonly,
    verificationRequired,
    domainRequired,
  }: {
    domains: z.infer<typeof ssoDomain>[];
    organizationId: string;
    readonly: boolean;
    verificationRequired: boolean;
    domainRequired: boolean;
  } = $props();

  // The open dialog is part of the URL, so it can be shared and survives a reload:
  // `add` asks for a new domain and `domain` shows the DNS record of a pending one.
  const adding = $derived(!readonly && page.url.searchParams.has("add"));

  const selected = $derived(page.url.searchParams.get("domain"));

  const current = $derived(domains.find((entry) => entry.domain === selected) ?? null);

  const open = $derived(adding || Boolean(current?.record));

  let input = $state("");

  let dialogError = $state("");

  let busy = $state(false);

  let removing = $state<string | null>(null);

  let rowError = $state<{ domain: string; message: string } | null>(null);

  let verified = $state("");

  const failure = (cause: unknown, fallback: string) =>
    isHttpError(cause) ? cause.body.message : cause instanceof Error ? cause.message : fallback;

  const navigate = (dialog: { add: true } | { domain: string } | null) => {
    const url = new URL(page.url.href);
    url.searchParams.delete("add");
    url.searchParams.delete("domain");

    if (dialog && "add" in dialog) url.searchParams.set("add", "");
    else if (dialog) url.searchParams.set("domain", dialog.domain);

    return goto(url, { reset: false });
  };

  const close = () => navigate(null);

  const startAdding = () => {
    input = "";
    dialogError = "";
    verified = "";

    return navigate({ add: true });
  };

  const showRecord = (domain: string) => {
    dialogError = "";
    verified = "";

    return navigate({ domain });
  };

  const add = async (event: SubmitEvent) => {
    event.preventDefault();
    const parsed = companyDomain.safeParse(input);

    if (!parsed.success) {
      dialogError = parsed.error.issues[0]?.message ?? "Enter a valid domain.";

      return;
    }

    busy = true;
    dialogError = "";

    try {
      await addCompanyDomain({ organizationId, domain: parsed.data });
      // Operator-trusted installations use domains for discovery only.
      await navigate(verificationRequired ? { domain: parsed.data } : null);
    } catch (cause) {
      dialogError = failure(cause, "The domain could not be added.");
    } finally {
      busy = false;
    }
  };

  const verify = async () => {
    if (!selected) return;
    busy = true;
    dialogError = "";

    try {
      await verifyCompanyDomain({ organizationId, domain: selected });
      verified = selected;
      await close();
    } catch (cause) {
      dialogError = failure(cause, "The DNS record could not be verified.");
    } finally {
      busy = false;
    }
  };

  const remove = async (domain: string) => {
    removing = domain;
    rowError = null;
    verified = "";

    try {
      await removeCompanyDomain({ organizationId, domain });
    } catch (cause) {
      rowError = { domain, message: failure(cause, "The domain could not be removed.") };
    } finally {
      removing = null;
    }
  };
</script>

<section class="rounded-xl border" aria-labelledby="email-domains-title">
  <div class="flex flex-wrap items-start justify-between gap-4 p-6">
    <div class="max-w-md">
      <h2 id="email-domains-title" class="text-base font-semibold">Email domains</h2>
      <p class="text-muted-foreground mt-2 text-sm leading-6">
        {verificationRequired
          ? "Members with these addresses sign in through company SSO. Each domain is verified with its own DNS record."
          : "Email domains help members find company sign-in from their email address. Your installation trusts the configured provider, so DNS verification is optional."}
      </p>
    </div>
    <Button variant="outline" size="sm" disabled={readonly} onclick={startAdding}>Add domain</Button
    >
  </div>
  {#if verified}<div class="px-6 pb-4">
      <Feedback kind="success">{verified} is verified.</Feedback>
    </div>{/if}
  {#if domains.length === 0}
    <div class="border-t">
      <EmptyState
        title="No email domains"
        description={domainRequired
          ? "Add the domain of your members' email addresses to use company SSO."
          : "Company sign-in is available without an email domain. Add one to help members find it by email."}
        >{#snippet icon()}<Globe />{/snippet}</EmptyState
      >
    </div>
  {:else}
    <ul class="divide-y border-t" aria-label="Email domains">
      {#each domains as entry (entry.domain)}
        <li class="px-6 py-3.5">
          <div class="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
            <p class="min-w-0 basis-full truncate text-sm font-medium sm:flex-1 sm:basis-0">
              {entry.domain}
            </p>
            {#if verificationRequired}<StatusBadge
                tone={entry.verified ? "success" : "pending"}
                label={entry.verified ? "Verified" : "Pending"}
              />{/if}
            <div class="ml-auto flex items-center gap-1">
              {#if verificationRequired && !entry.verified}
                <Button variant="outline" size="sm" onclick={() => showRecord(entry.domain)}
                  >Verify</Button
                >
              {/if}
              {#if domains.length > 1 || !domainRequired}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${entry.domain}`}
                  title={`Remove ${entry.domain}`}
                  disabled={readonly || removing !== null}
                  onclick={() => remove(entry.domain)}><Trash /></Button
                >
              {/if}
            </div>
          </div>
          {#if rowError?.domain === entry.domain}<p
              class="text-destructive mt-2 text-xs"
              role="alert"
            >
              {rowError.message}
            </p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<Dialog.Root
  {open}
  onOpenChange={(next) => {
    if (!next && !busy) void close();
  }}
>
  <Dialog.Content
    class="sm:max-w-lg"
    showCloseButton={!busy}
    onInteractOutside={(event) => {
      if (busy) event.preventDefault();
    }}
    onEscapeKeydown={(event) => {
      if (busy) event.preventDefault();
    }}
  >
    {#if current?.record}
      <Dialog.Header>
        <Dialog.Title>Verify {current.domain}</Dialog.Title>
        <Dialog.Description>
          Add this TXT record at your DNS provider, then verify. New records can take a few minutes
          to appear.
        </Dialog.Description>
      </Dialog.Header>
      <DnsRecord name={current.record.name} value={current.record.value} />
      {#if dialogError}<p class="text-destructive text-sm" role="alert">{dialogError}</p>{/if}
      <Dialog.Footer>
        <Button variant="outline" disabled={busy} onclick={close}>Verify later</Button>
        <Button disabled={busy} onclick={verify}>{busy ? "Verifying …" : "Verify domain"}</Button>
      </Dialog.Footer>
    {:else}
      <form class="grid gap-4" onsubmit={add}>
        <Dialog.Header>
          <Dialog.Title>Add email domain</Dialog.Title>
          <Dialog.Description>
            Enter the part of your members' email addresses after the @.
          </Dialog.Description>
        </Dialog.Header>
        <div class="space-y-2">
          <Label for="new-domain">Domain</Label>
          <Input
            id="new-domain"
            bind:value={input}
            placeholder="example.com"
            autocomplete="off"
            aria-invalid={dialogError ? true : undefined}
            aria-describedby={dialogError ? "new-domain-error" : undefined}
            required
          />
          {#if dialogError}<p id="new-domain-error" class="text-destructive text-xs" role="alert">
              {dialogError}
            </p>{/if}
        </div>
        <Dialog.Footer>
          <Button variant="outline" type="button" disabled={busy} onclick={close}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Adding …" : "Add domain"}</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
