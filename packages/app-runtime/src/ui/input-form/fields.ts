import type { InputField } from "@platform/contracts";

// datetime-local holds local time without a zone.
const localTime = (instant: string) => {
  const date = new Date(instant);

  if (Number.isNaN(date.getTime())) return "";

  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
};

export type FieldValue = string | boolean | undefined;

export const initialValue = (field: InputField): FieldValue => {
  if (field.type === "boolean") return field.default ?? false;

  if (field.default === undefined) return "";

  if (field.type === "string" && field.format === "date-time") return localTime(field.default);

  return String(field.default);
};

// The answer content for one field; undefined leaves an optional field out.
export const answerValue = (field: InputField, value: FieldValue) => {
  if (field.type === "boolean") return value === true;
  const text = String(value ?? "");

  if (text === "") return undefined;

  if (field.type !== "string") return Number(text);

  if (field.format === "date-time")
    // An unchanged default keeps its instant, even in the hour repeated when daylight saving ends.
    return field.default !== undefined && text === initialValue(field)
      ? field.default
      : new Date(text).toISOString();

  return text;
};
