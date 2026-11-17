import { getContext, setContext, type Component, type Snippet } from "svelte";
import type { Tooltip } from "layerchart";
import { z } from "zod";

export const THEMES = { light: "", dark: ".dark" } as const;

export type ChartConfig = {
  [k in string]: {
    label?: string;
    icon?: Component;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  );
};

export type ExtractSnippetParams<T> = T extends Snippet<[infer P]> ? P : never;

export type TooltipPayload = Tooltip.TooltipSeries;

// Helper to extract item config from a payload.
export function getPayloadConfigFromPayload<TData>(
  config: ChartConfig,
  payload: TooltipPayload | undefined,
  key: string,
  data?: TData | null,
) {
  if (!payload) return undefined;

  const stringField = z.object({ [key]: z.string() });
  let configLabelKey = key;

  if (payload.key === key) {
    configLabelKey = payload.key;
  } else if (payload.label === key) {
    configLabelKey = payload.label;
  } else {
    configLabelKey =
      stringField.safeParse(payload).data?.[key] ??
      stringField.safeParse(payload.config).data?.[key] ??
      stringField.safeParse(data).data?.[key] ??
      key;
  }

  return configLabelKey in config ? config[configLabelKey] : config[key];
}

type ChartContextValue = {
  config: ChartConfig;
};

const chartContextKey = Symbol("chart-context");

export function setChartContext(value: ChartContextValue) {
  return setContext(chartContextKey, value);
}

export function useChart() {
  return getContext<ChartContextValue>(chartContextKey);
}
