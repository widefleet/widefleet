<script lang="ts">
  import type { InputField } from "@platform/contracts";
  import { Checkbox } from "@platform/ui/checkbox";
  import * as Field from "@platform/ui/field";
  import { Input } from "@platform/ui/input";
  import { NativeSelect, NativeSelectOption } from "@platform/ui/native-select";
  import type { FieldValue } from "./fields.ts";

  let {
    id,
    name,
    field,
    required,
    value = $bindable(),
  }: {
    id: string;
    name: string;
    field: InputField;
    required: boolean;
    value: FieldValue;
  } = $props();

  const types = {
    email: "email",
    uri: "url",
    date: "date",
    "date-time": "datetime-local",
  } as const;
</script>

{#if field.type === "boolean"}
  <Field.Field orientation="horizontal">
    <Checkbox {id} bind:checked={() => value === true, (checked) => (value = checked)} />
    <Field.Content>
      <Field.Label for={id}>{field.title ?? name}</Field.Label>
      {#if field.description}<Field.Description>{field.description}</Field.Description>{/if}
    </Field.Content>
  </Field.Field>
{:else}
  <Field.Field>
    <Field.Label for={id}>{field.title ?? name}</Field.Label>
    {#if field.type === "string" && field.enum}
      <NativeSelect
        {id}
        {required}
        bind:value={() => String(value ?? ""), (selected) => (value = selected)}
      >
        {#if !required}<NativeSelectOption value="" />{/if}
        {#each field.enum as option, index (option)}
          <NativeSelectOption value={option}
            >{field.enumNames?.[index] ?? option}</NativeSelectOption
          >
        {/each}
      </NativeSelect>
    {:else if field.type === "string"}
      <Input
        {id}
        {required}
        type={field.format ? types[field.format] : "text"}
        step={field.format === "date-time" ? 1 : undefined}
        minlength={field.minLength}
        maxlength={field.maxLength}
        bind:value={() => String(value ?? ""), (entered) => (value = entered)}
      />
    {:else}
      <Input
        {id}
        {required}
        type="number"
        step={field.type === "integer" ? 1 : "any"}
        min={field.minimum}
        max={field.maximum}
        bind:value={() => String(value ?? ""), (entered) => (value = String(entered ?? ""))}
      />
    {/if}
    {#if field.description}<Field.Description>{field.description}</Field.Description>{/if}
  </Field.Field>
{/if}
