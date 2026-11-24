<script lang="ts">
  import Markdown from "./Markdown.svelte";
  import type { getServiceDescription } from "#lib/services.remote";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";

  // What an app exposes to other apps and agents, with the documentation of its deployment.
  let { service }: { service: Awaited<ReturnType<typeof getServiceDescription>> } = $props();

  const reference = $derived(service.reference);

  const empty = $derived(
    reference !== null && reference.entrypoints.length === 0 && reference.types.length === 0,
  );
</script>

{#snippet code(source: string)}<pre
    class="bg-muted overflow-x-auto rounded-lg px-4 py-3 font-mono text-xs leading-6">{source}</pre>{/snippet}

<div class="grid gap-10 lg:grid-cols-[minmax(0,1fr)_15rem]">
  <aside class="space-y-8 text-sm lg:order-last" aria-label="API details">
    <dl class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-xs lg:grid-cols-1">
      <div class="contents lg:block">
        <dt class="text-muted-foreground lg:mb-1.5">Entrypoints</dt>
        <dd class="font-mono wrap-anywhere">{service.entrypoints.join(", ")}</dd>
      </div>
      <div class="contents lg:block">
        <dt class="text-muted-foreground lg:mb-1.5">Deployment</dt>
        <dd class="truncate font-mono" title={service.deploymentId}>
          {service.deploymentId.slice(0, 8)}
        </dd>
      </div>
    </dl>
    {#if reference && !empty}<nav aria-label="On this page" class="hidden lg:block">
        <p class="text-muted-foreground mb-2 text-xs">On this page</p>
        <ul class="space-y-1.5 text-xs">
          {#each reference.entrypoints as entry (entry.name)}
            {#each entry.methods as method (method.name)}<li>
                <a
                  href={`#${entry.name}-${method.name}`}
                  class="text-muted-foreground hover:text-foreground font-mono">{method.name}</a
                >
              </li>{/each}
          {/each}
          {#if reference.types.length}<li>
              <a href="#types" class="text-muted-foreground hover:text-foreground">Types</a>
            </li>{/if}
        </ul>
      </nav>{/if}
  </aside>
  <div class="min-w-0">
    {#if service.entrypoints.length === 0}
      <p class="text-muted-foreground text-sm">This app does not expose an API.</p>
    {:else if reference && !empty}
      {#each reference.entrypoints as entry (entry.name)}
        <section aria-labelledby={`entry-${entry.name}`} class="mb-12">
          <div class="flex flex-wrap items-center gap-2">
            <h2 id={`entry-${entry.name}`} class="text-lg font-semibold">{entry.name}</h2>
            {#if entry.http}<span
                class="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 font-mono text-[11px]"
                >fetch()</span
              >{/if}
          </div>
          {#if entry.description}<div class="text-muted-foreground mt-3">
              <Markdown html={entry.description} />
            </div>{/if}
          {#each entry.methods as method (method.name)}
            <article
              id={`${entry.name}-${method.name}`}
              class="mt-6 scroll-mt-6 space-y-4 border-t pt-6"
            >
              <h3 class="font-mono text-sm font-semibold">{method.name}</h3>
              {#if method.summary}<Markdown html={method.summary} />{/if}
              {#each method.signatures as signature, index (index)}
                {@render code(signature.code)}
                {#if signature.parameters.length || signature.returns.description}
                  <dl
                    class="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm"
                  >
                    {#each signature.parameters as parameter (parameter.name)}
                      <dt class="min-w-0">
                        <span class="font-mono text-xs">{parameter.name}</span>
                        <span class="text-muted-foreground block font-mono text-xs wrap-anywhere"
                          >{parameter.type}</span
                        >
                      </dt>
                      <dd class="text-muted-foreground min-w-0">
                        {#if parameter.description}<Markdown html={parameter.description} />{/if}
                      </dd>
                    {/each}
                    {#if signature.returns.description}
                      <dt class="min-w-0">
                        <span class="font-mono text-xs">returns</span>
                        <span class="text-muted-foreground block font-mono text-xs wrap-anywhere"
                          >{signature.returns.type}</span
                        >
                      </dt>
                      <dd class="text-muted-foreground min-w-0">
                        <Markdown html={signature.returns.description} />
                      </dd>
                    {/if}
                  </dl>
                {/if}
              {/each}
              {#if method.remarks}<div class="text-muted-foreground">
                  <Markdown html={method.remarks} />
                </div>{/if}
              {#each method.throws as error, index (index)}
                <div class="text-muted-foreground"><Markdown html={error} /></div>
              {/each}
              {#if method.examples}<div>
                  <p class="text-muted-foreground mb-2 text-xs font-medium">Example</p>
                  <Markdown html={method.examples} />
                </div>{/if}
            </article>
          {/each}
        </section>
      {/each}
      {#if reference.types.length}
        <section id="types" aria-labelledby="types-heading" class="scroll-mt-6">
          <h2 id="types-heading" class="mb-3 text-lg font-semibold">Types</h2>
          <ul class="divide-y border-y">
            {#each reference.types as type (type.name)}
              <li>
                <details class="group">
                  <summary
                    class="hover:bg-muted/40 flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden"
                  >
                    <ChevronRight
                      class="text-muted-foreground size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                    />
                    <span class="font-mono text-sm">{type.name}</span>
                  </summary>
                  <div class="space-y-3 px-3 pb-4 pl-9">
                    {#if type.description}<div class="text-muted-foreground">
                        <Markdown html={type.description} />
                      </div>{/if}
                    {@render code(type.definition)}
                    {#if type.examples}<Markdown html={type.examples} />{/if}
                  </div>
                </details>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    {:else if reference}
      <p class="text-muted-foreground text-sm">
        No API documentation was generated. Check the provider app’s deployment diagnostics.
      </p>
    {:else}
      <p class="text-muted-foreground text-sm">
        This deployment has no API documentation. Redeploy the provider app with a CLI that supports
        API documentation.
      </p>
    {/if}
  </div>
</div>
