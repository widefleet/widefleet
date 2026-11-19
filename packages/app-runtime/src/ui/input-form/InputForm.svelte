<script lang="ts">
  import {
    App,
    applyDocumentTheme,
    applyHostFonts,
    applyHostStyleVariables,
    type McpUiHostContext,
  } from "@modelcontextprotocol/ext-apps";
  import { Button } from "@platform/ui/button";
  import * as Field from "@platform/ui/field";
  import { z } from "zod";
  import {
    inputFormMetaKey,
    inputFormQuestion,
    type InputFormQuestion,
  } from "../../mcp-input-form.ts";
  import InputField from "./InputField.svelte";
  import { answerValue, initialValue, type FieldValue } from "./fields.ts";

  const meta = z.looseObject({ [inputFormMetaKey]: inputFormQuestion });

  // Replaced as a whole, never changed in place; plain objects can be posted to the host.
  let question = $state.raw<InputFormQuestion>();

  let values = $state<Record<string, FieldValue>>({});

  let status = $state("");

  let sending = $state(false);

  const app = new App({ name: "Widefleet input form", version: "1.0.0" });

  // Request and field names cannot contain dots, so the key is unambiguous.
  const key = (name: string, field: string) => `${name}.${field}`;

  const show = (next: InputFormQuestion) => {
    question = next;
    status = "";
    values = Object.fromEntries(
      Object.entries(next.inputRequests).flatMap(([name, request]) =>
        Object.entries(request.requestedSchema.properties).map(([field, schema]) => [
          key(name, field),
          initialValue(schema),
        ]),
      ),
    );
  };

  const theme = (context: McpUiHostContext | undefined) => {
    if (context?.theme) applyDocumentTheme(context.theme);

    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);

    if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  };

  const text = (content: { type: string; text?: string }[] | undefined) =>
    (content ?? [])
      .flatMap((entry) => (entry.type === "text" && entry.text ? [entry.text] : []))
      .join("\n");

  // The model learns the outcome from the host; hosts differ in which path they offer.
  const report = async (outcome: string) => {
    const host = app.getHostCapabilities();
    const content = [{ type: "text" as const, text: outcome }];

    // Delivery is best effort: the person already sees the outcome in the form.
    if (host?.updateModelContext) await app.updateModelContext({ content }).catch(() => undefined);

    if (host?.message)
      await app
        .sendMessage({
          role: "user",
          content: host.updateModelContext
            ? [{ type: "text", text: "I answered the form." }]
            : content,
        })
        .catch(() => undefined);
  };

  const reply = async (action: "accept" | "decline") => {
    if (!question) return;
    const asked = question;
    sending = true;
    status = "Sending…";

    const inputResponses = Object.fromEntries(
      Object.entries(asked.inputRequests).map(([name, request]) => [
        name,
        action === "accept"
          ? {
              action,
              content: Object.fromEntries(
                Object.entries(request.requestedSchema.properties).flatMap(([field, schema]) => {
                  const value = answerValue(schema, values[key(name, field)]);

                  return value === undefined ? [] : [[field, value]];
                }),
              ),
            }
          : { action },
      ]),
    );

    try {
      const result = await app.callServerTool({
        name: "answer",
        arguments: { ...asked.call, requestState: asked.requestState, inputResponses },
      });

      const next = meta.safeParse(result._meta);
      const message = text(result.content);

      if (next.success) {
        show(next.data[inputFormMetaKey]);

        return;
      }

      question = undefined;

      if (result.isError) {
        status = `The answer was not accepted. ${message}`;
        await report(
          `The person answered the form for ${asked.call.method}, but the call failed: ${message}`,
        );
      } else {
        status = "Answer sent.";
        await report(`The person answered the form for ${asked.call.method}. Result: ${message}`);
      }
    } catch (error) {
      status = `Sending failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      sending = false;
    }
  };

  app.addEventListener("toolresult", (result) => {
    const asked = meta.safeParse(result._meta);

    if (asked.success) show(asked.data[inputFormMetaKey]);
    else status = text(result.content);
  });

  app.addEventListener("hostcontextchanged", theme);

  void app.connect().then(() => theme(app.getHostContext()));
</script>

<main class="bg-background text-foreground p-4">
  {#if question}
    <form
      class="flex flex-col gap-5"
      onsubmit={(event) => {
        event.preventDefault();
        void reply("accept");
      }}
    >
      {#each Object.entries(question.inputRequests) as [name, request] (name)}
        <Field.Set>
          <Field.Description class="text-foreground text-sm whitespace-pre-wrap"
            >{request.message}</Field.Description
          >
          <Field.Group>
            {#each Object.entries(request.requestedSchema.properties) as [field, schema] (field)}
              <InputField
                id={key(name, field)}
                name={field}
                field={schema}
                required={request.requestedSchema.required?.includes(field) ?? false}
                bind:value={values[key(name, field)]}
              />
            {/each}
          </Field.Group>
        </Field.Set>
      {/each}
      <div class="flex gap-2">
        <Button type="submit" disabled={sending}>Submit</Button>
        <Button
          type="button"
          variant="outline"
          disabled={sending}
          onclick={() => void reply("decline")}
        >
          Decline
        </Button>
      </div>
    </form>
  {/if}
  {#if status}
    <p
      role="status"
      class={["text-muted-foreground text-sm whitespace-pre-wrap", question && "mt-4"]}
    >
      {status}
    </p>
  {/if}
</main>
