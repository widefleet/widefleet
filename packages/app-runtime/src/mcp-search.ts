import { summaryLine, type serviceDocumentation } from "@platform/contracts";
import type { z } from "zod";

type EntrypointDocumentation = z.infer<typeof serviceDocumentation>["entrypoints"][number];

type MethodDocumentation = EntrypointDocumentation["methods"][number];

export interface SearchableMethod {
  appId: string;
  hostname: string;
  entrypoint: string;
  method: string;
  summary: string;
  // Space-separated words from methodTerms, precomputed when the index is written.
  nameTerms: string;
  terms: string;
}

export interface SearchRequest {
  query: string;
  hostname?: string | undefined;
  entrypoint?: string | undefined;
  limit: number;
  offset: number;
}

const stem = (word: string) =>
  word.length > 4 && word.endsWith("ies")
    ? `${word.slice(0, -3)}y`
    : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
      ? word.slice(0, -1)
      : word;

// Identifiers and prose yield the same words: "searchAnalytics",
// "search-analytics" and "Search analytics" all become "search analytic".
const split = (text: string) =>
  text
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const words = (text: string) => split(text).map(stem);

// A word as written, where it differs from its stem, so a query for "issues"
// ranks a method named `issues` above one named `issueShare`. The prefix keeps
// these terms apart from stems.
const surface = (text: string) =>
  split(text).flatMap((word) => (stem(word) === word ? [] : [`=${word}`]));

// Bounds an index entry independently of documentation size. Names come first,
// so long prose cannot push method or parameter names out of the budget.
const maximumTerms = 256;

export const methodTerms = (
  hostname: string,
  entrypoint: EntrypointDocumentation,
  method: MethodDocumentation,
) => {
  const parameters = method.signatures.flatMap((signature) => signature.parameters);

  return {
    nameTerms: [...words(method.name), ...surface(method.name)].join(" "),
    terms: words(
      [
        ...parameters.map((parameter) => parameter.name),
        hostname,
        entrypoint.name,
        method.summary,
        ...parameters.map((parameter) => parameter.description),
        // Shared by every method of the entrypoint, so only its first line counts.
        summaryLine(entrypoint.summary),
      ].join(" "),
    )
      .slice(0, maximumTerms)
      .join(" "),
  };
};

// A word in a method's name counts this many times as one in its documentation.
const nameWeight = 3;

type Fields = { name: string[]; rest: string[] };

const counts = (field: string[]) => {
  const result = new Map<string, number>();

  for (const word of field) result.set(word, (result.get(word) ?? 0) + 1);

  return result;
};

// Okapi BM25F over the methods the caller may see: BM25 with the name and the
// documentation as separately normalized fields, the name weighted higher. Any
// query word qualifies a method; methods matching more and rarer words, above
// all in their names, rank first.
const score = (documents: Fields[], query: string[]) => {
  const k1 = 1.2;
  const b = 0.75;

  const average = (field: keyof Fields) =>
    documents.reduce((total, document) => total + document[field].length, 0) / documents.length ||
    1;

  const averages = { name: average("name"), rest: average("rest") };

  const frequencies = documents.map((document) => ({
    name: counts(document.name),
    rest: counts(document.rest),
    length: { name: document.name.length, rest: document.rest.length },
  }));

  const idf = new Map(
    query.map((word) => {
      const containing = frequencies.filter(
        (document) => document.name.has(word) || document.rest.has(word),
      ).length;

      return [word, Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5))];
    }),
  );

  const normalized = (frequency: number, length: number, averageLength: number) =>
    frequency / (1 - b + (b * length) / averageLength);

  return frequencies.map((document) =>
    query.reduce((total, word) => {
      const frequency =
        nameWeight * normalized(document.name.get(word) ?? 0, document.length.name, averages.name) +
        normalized(document.rest.get(word) ?? 0, document.length.rest, averages.rest);

      return frequency ? total + ((idf.get(word) ?? 0) * frequency) / (k1 + frequency) : total;
    }, 0),
  );
};

const order = (left: SearchableMethod, right: SearchableMethod) =>
  left.hostname.localeCompare(right.hostname, "en") ||
  left.entrypoint.localeCompare(right.entrypoint, "en") ||
  left.method.localeCompare(right.method, "en");

// Ranks every permitted method before paging, so the first page holds the best matches.
export const rankMethods = (methods: SearchableMethod[], request: SearchRequest) => {
  const query = [...new Set([...words(request.query), ...surface(request.query)])];

  const candidates = methods.filter(
    (method) =>
      (request.hostname === undefined || method.hostname === request.hostname) &&
      (request.entrypoint === undefined || method.entrypoint === request.entrypoint),
  );

  let ranked: SearchableMethod[];

  if (!query.length) ranked = candidates.toSorted(order);
  else {
    const scores = score(
      candidates.map((method) => ({
        name: method.nameTerms.split(" ").filter(Boolean),
        rest: method.terms.split(" ").filter(Boolean),
      })),
      query,
    );

    ranked = candidates
      .flatMap((method, index) => {
        const value = scores[index] ?? 0;

        return value > 0 ? [{ method, score: value }] : [];
      })
      .sort((left, right) => right.score - left.score || order(left.method, right.method))
      .map((entry) => entry.method);
  }

  const page = ranked.slice(request.offset, request.offset + request.limit);
  const remaining = Math.max(0, ranked.length - request.offset - page.length);

  return {
    methods: page,
    remaining,
    next: remaining ? { ...request, offset: request.offset + page.length } : null,
  };
};
