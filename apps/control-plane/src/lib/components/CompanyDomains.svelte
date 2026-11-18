<script lang="ts">
  import { isHttpError } from "@sveltejs/kit";
  import Globe from "@lucide/svelte/icons/globe";
  import Trash from "@lucide/svelte/icons/trash-2";
  import { companyDomain, type ssoDomain } from "@platform/contracts";
  import type { z } from "zod";
  import { addCompanyDomain, removeCompanyDomain, verifyCompanyDomain } from "#lib/settings.remote";
  import { Badge } from "@platform/ui/badge";
  import { Button } from "@platform/ui/button";
  import * as Dialog from "@platform/ui/dialog";
  import { Input } from "@platform/ui/input";
  import { Label } from "@platform/ui/label";
  import CopyButton from "./CopyButton.svelte";
  import EmptyState from "./EmptyState.svelte";
  import Feedback from "./Feedback.svelte";

  let {
    domains,
    organizationId,
    readonly,
  }: { domains: z.infer<typeof ssoDomain>[]; organizationId: string; readonly: boolean } = $props();

  // The dialog asks for a new domain, then shows the DNS record of the selected one.
  let open = $state(false);

  let selected = $state<string | null>(null);

  let input = $state("");

  let dialogError = $state("");

  let busy = $state(false);

  let removing = $state<string | null>(null);

  let rowError = $state<{ domain: string; message: string } | null>(null);

  let verified = $state("");

  const current = $derived(domains.find((entry) => entry.domain === selected) ?? null);

  const failure = (cause: unknown, fallback: string) =>
    isHttpError(cause) ? cause.body.message : cause instanceof Error ? cause.message : fallback;

  const startAdding = () => {
    selected = null;
    input = "";
    dialogError = "";
    open = true;
  };

  const showRecord = (domain: string) => {
    selected = domain;
    dialogError = "";
    open = true;
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
      selected = parsed.data;
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
      open = false;
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
        Members with these addresses sign in through company SSO. Each domain is verified with its
        own DNS record.
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
        description="Add the domain of your members' email addresses to use company SSO."
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
            <Badge
              variant="outline"
              class="gap-1.5 whitespace-nowrap border-transparent bg-muted/60 px-2 py-1 font-normal"
            >
              <span
                class={`size-1.5 rounded-full ${entry.verified ? "bg-emerald-500" : "bg-amber-500"}`}
                aria-hidden="true"
              ></span>
              {entry.verified ? "Verified" : "Pending"}
            </Badge>
            <div class="ml-auto flex items-center gap-1">
              {#if !entry.verified}
                <Button variant="outline" size="sm" onclick={() => showRecord(entry.domain)}
                  >Verify</Button
                >
              {/if}
              {#if domains.length > 1}
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

<Dialog.Root bind:open>
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
      <dl
        class="bg-muted/50 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 rounded-lg border px-4 py-2 text-xs"
      >
        <dt class="text-muted-foreground py-2">Type</dt>
        <dd class="col-span-2 py-2 font-mono">TXT</dd>
        <dt class="text-muted-foreground py-2">Name</dt>
        <dd class="font-mono wrap-anywhere">{current.record.name}</dd>
        <dd><CopyButton value={current.record.name} label="Copy record name" /></dd>
        <dt class="text-muted-foreground py-2">Value</dt>
        <dd class="font-mono wrap-anywhere">{current.record.value}</dd>
        <dd><CopyButton value={current.record.value} label="Copy record value" /></dd>
      </dl>
      {#if dialogError}<p class="text-destructive text-sm" role="alert">{dialogError}</p>{/if}
      <Dialog.Footer>
        <Button variant="outline" disabled={busy} onclick={() => (open = false)}
          >Verify later</Button
        >
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
          <Button variant="outline" type="button" disabled={busy} onclick={() => (open = false)}
            >Cancel</Button
          >
          <Button type="submit" disabled={busy}>{busy ? "Adding …" : "Add domain"}</Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
