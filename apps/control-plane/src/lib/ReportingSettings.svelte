<script lang="ts">
  import { untrack } from "svelte";
  import { reportingStatus } from "@platform/contracts";
  import { z } from "zod";
  import { Button } from "#shadcn/components/ui/button/index.js";
  import { Textarea } from "#shadcn/components/ui/textarea/index.js";
  import { Switch } from "#shadcn/components/ui/switch/index.js";
  import Feedback from "#shadcn/components/Feedback.svelte";
  import { getReportingPreview, updateReporting } from "#lib/reporting.remote";

  let { initial }: { initial: z.infer<typeof reportingStatus> } = $props();

  let status = $state(untrack(() => initial));

  let usage = $state(untrack(() => initial.effective.usage));

  let crashes = $state(untrack(() => initial.effective.crashes));

  let busy = $state(false);

  let message = $state("");

  let preview = $state("");

  let failed = $state(false);

  let inspecting = $state(false);

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    busy = true;
    message = "";
    failed = false;

    try {
      status = await updateReporting({ usage, crashes });
      usage = status.effective.usage;
      crashes = status.effective.crashes;
      message = "Telemetry settings saved.";
    } catch (cause) {
      failed = true;
      message = cause instanceof Error ? cause.message : "Could not save changes.";
    } finally {
      busy = false;
    }
  };

  const inspect = async () => {
    inspecting = true;
    message = "";
    failed = false;

    try {
      const report = getReportingPreview();
      await report.refresh();
      preview = JSON.stringify(await report, null, 2);
    } catch {
      failed = true;
      message = "Could not load the preview.";
    } finally {
      inspecting = false;
    }
  };
</script>

<section aria-labelledby="reporting-heading" class="max-w-2xl space-y-6">
  <div>
    <h2 id="reporting-heading" class="text-base font-semibold">Improve Widefleet</h2>
    <p class="text-muted-foreground mt-2 text-sm leading-6">
      By default, this installation shares technical metadata with the Widefleet team through
      PostHog in the EU. You control each category independently.
    </p>
  </div>
  <form onsubmit={save} class="space-y-6">
    <div class="divide-y rounded-xl border">
      <div class="p-5">
        <div class="flex items-center justify-between gap-4">
          <label for="report-usage" class="text-sm font-medium">Share usage and configuration</label
          ><Switch id="report-usage" bind:checked={usage} disabled={status.managed.usage || busy} />
        </div>
        <p class="text-muted-foreground mt-3 text-xs leading-6">
          App, fleet and preview counts, the number of active workspace users, features used,
          deployment results and durations, plus version, operating system, storage, sign-in and TLS
          settings.
        </p>
        {#if status.managed.usage}<p class="text-muted-foreground mt-2 text-xs">
            Set by the server configuration (PLATFORM_USAGE_REPORTING).
          </p>{/if}
      </div>
      <div class="p-5">
        <div class="flex items-center justify-between gap-4">
          <label for="report-crashes" class="text-sm font-medium">Share error reports</label><Switch
            id="report-crashes"
            bind:checked={crashes}
            disabled={status.managed.crashes || busy}
          />
        </div>
        <p class="text-muted-foreground mt-3 text-xs leading-6">
          Error types and sanitized locations in Widefleet code. No free-text error messages, app
          content, user identifiers, names or domains.
        </p>
        {#if status.managed.crashes}<p class="text-muted-foreground mt-2 text-xs">
            Set by the server configuration (PLATFORM_CRASH_REPORTING).
          </p>{/if}
      </div>
    </div>
    <Button type="submit" disabled={busy || (status.managed.usage && status.managed.crashes)}
      >{busy ? "Saving …" : "Save telemetry settings"}</Button
    >
  </form>
  {#if message}<Feedback kind={failed ? "error" : "success"}>{message}</Feedback>{/if}
  <div class="border-t pt-6">
    <h3 class="text-sm font-medium">See what gets shared</h3>
    <p class="text-muted-foreground mt-2 mb-4 text-xs leading-6">
      Preview the usage data that would be sent. The CLI has its own local setting: <code
        >widefleet telemetry disable</code
      >.
    </p>
    <Button variant="outline" onclick={inspect} disabled={inspecting}
      >{inspecting ? "Loading preview …" : "View usage report"}</Button
    >{#if preview}<Textarea
        readonly
        value={preview}
        rows={12}
        class="bg-muted/50 mt-4 max-h-96 font-mono text-xs leading-6"
        aria-label="Usage report preview"
      />{/if}
    <p class="text-muted-foreground mt-5 text-[11px] wrap-anywhere">
      Installation ID: <code>{status.installationId}</code>
    </p>
  </div>
</section>
