<script lang="ts">
	import { DateFormatter, getLocalTimeZone, type DateValue } from "@internationalized/date";
	import CalendarMonthSelect from "./calendar-month-select.svelte";
	import CalendarYearSelect from "./calendar-year-select.svelte";
	import type Calendar from "./calendar.svelte";
	import type { ComponentProps } from "svelte";
	import type { Calendar as Primitive } from "bits-ui";

	let {
		captionLayout,
		months,
		monthFormat,
		years,
		yearFormat,
		month,
		locale,
		placeholder = $bindable(),
		monthIndex = 0,
	}: {
		captionLayout: ComponentProps<typeof Calendar>["captionLayout"];
		months: ComponentProps<typeof CalendarMonthSelect>["months"];
		monthFormat: ComponentProps<typeof CalendarMonthSelect>["monthFormat"];
		years: ComponentProps<typeof CalendarYearSelect>["years"];
		yearFormat: ComponentProps<typeof CalendarYearSelect>["yearFormat"];
		month: DateValue;
		placeholder: DateValue | undefined;
		locale: string;
		monthIndex: number;
	} = $props();

	const monthSelectProps = $derived.by(() => {
		const props: Pick<Primitive.MonthSelectProps, "months" | "monthFormat"> = {};

		if (months !== undefined) props.months = months;

		if (monthFormat !== undefined) props.monthFormat = monthFormat;

		return props;
	});

	const yearSelectProps = $derived.by(() => {
		const props: Pick<Primitive.YearSelectProps, "years" | "yearFormat"> = {};

		if (years !== undefined) props.years = years;

		if (yearFormat !== undefined) props.yearFormat = yearFormat;

		return props;
	});

	function formatYear(date: DateValue) {
		const dateObj = date.toDate(getLocalTimeZone());

		if (yearFormat === undefined || yearFormat === "numeric" || yearFormat === "2-digit") {
			return new DateFormatter(locale, { year: yearFormat }).format(dateObj);
		}

		return yearFormat(dateObj.getFullYear());
	}

	function formatMonth(date: DateValue) {
		const dateObj = date.toDate(getLocalTimeZone());

		if (
			monthFormat === undefined || monthFormat === "numeric" || monthFormat === "2-digit" ||
			monthFormat === "long" || monthFormat === "short" || monthFormat === "narrow"
		) {
			return new DateFormatter(locale, { month: monthFormat }).format(dateObj);
		}

		return monthFormat(dateObj.getMonth() + 1);
	}
</script>

{#snippet MonthSelect()}
	<CalendarMonthSelect
		{...monthSelectProps}
		value={month.month}
		onchange={(e) => {
			if (!placeholder) return;

			const v = Number.parseInt(e.currentTarget.value);
			const newPlaceholder = placeholder.set({ month: v });
			placeholder = newPlaceholder.subtract({ months: monthIndex });
		}}
	/>
{/snippet}

{#snippet YearSelect()}
	<CalendarYearSelect {...yearSelectProps} value={month.year} />
{/snippet}

{#if captionLayout === "dropdown"}
	{@render MonthSelect()}
	{@render YearSelect()}
{:else if captionLayout === "dropdown-months"}
	{@render MonthSelect()}
	{#if placeholder}
		{formatYear(placeholder)}
	{/if}
{:else if captionLayout === "dropdown-years"}
	{#if placeholder}
		{formatMonth(placeholder)}
	{/if}
	{@render YearSelect()}
{:else}
	{formatMonth(month)} {formatYear(month)}
{/if}
