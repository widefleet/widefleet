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
const words = (text: string) =>
  text
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stem);

// Bounds an index entry independently of documentation size. Names come first,
// so long prose cannot push method or parameter names out of the budget.
const maximumTerms = 256;

export const methodTerms = (
  hostname: string,
  entrypoint: EntrypointDocumentation,
  method: MethodDocumentation,
) => {
  const parameters = method.signatures.flatMap((signature) => signature.parameters);

  return words(
    [
      method.name,
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
    .join(" ");
};

// Okapi BM25 over the methods the caller may see. Any query word qualifies a
// method; methods matching more and rarer words rank first.
const score = (documents: string[][], query: string[]) => {
  const k1 = 1.2;
  const b = 0.75;

  const average =
    documents.reduce((total, document) => total + document.length, 0) / documents.length;

  const frequencies = documents.map((document) => {
    const counts = new Map<string, number>();

    for (const word of document) counts.set(word, (counts.get(word) ?? 0) + 1);

    return counts;
  });

  const idf = new Map(
    query.map((word) => {
      const containing = frequencies.filter((counts) => counts.has(word)).length;

      return [word, Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5))];
    }),
  );

  return frequencies.map((counts, index) =>
    query.reduce((total, word) => {
      const frequency = counts.get(word) ?? 0;
      const length = documents[index]?.length ?? 0;

      return frequency
        ? total +
            ((idf.get(word) ?? 0) * frequency * (k1 + 1)) /
              (frequency + k1 * (1 - b + (b * length) / average))
        : total;
    }, 0),
  );
};

const order = (left: SearchableMethod, right: SearchableMethod) =>
  left.hostname.localeCompare(right.hostname, "en") ||
  left.entrypoint.localeCompare(right.entrypoint, "en") ||
  left.method.localeCompare(right.method, "en");

// Ranks every permitted method before paging, so the first page holds the best matches.
export const rankMethods = (methods: SearchableMethod[], request: SearchRequest) => {
  const query = [...new Set(words(request.query))];

  const candidates = methods.filter(
    (method) =>
      (request.hostname === undefined || method.hostname === request.hostname) &&
      (request.entrypoint === undefined || method.entrypoint === request.entrypoint),
  );

  let ranked: SearchableMethod[];

  if (!query.length) ranked = candidates.toSorted(order);
  else {
    const scores = score(
      candidates.map((method) => method.terms.split(" ").filter(Boolean)),
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
