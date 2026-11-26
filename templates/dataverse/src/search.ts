import type { DataverseApi } from "./api.ts";
import type { Environment } from "./context.ts";
import type { Arguments } from "./input.ts";
import type { RestOperation } from "./rest.ts";
import type { DataverseResult } from "./results.ts";
import { type DataverseProperties, runOperation } from "./run.ts";
import type { JsonValue } from "./selection.ts";

// Dataverse search's own endpoint, beside the Web API. It takes the parameters
// of the Web API's search actions and functions and answers alike.
const searchBase = "https://{environment}/api/search/v2.0/";

const searchOperation = (httpMethod: "GET" | "POST", path: string) =>
  ({
    httpMethod,
    path,
    pathParameters: {},
    queryParameters: {},
    headerParameters: { callerObjectId: "CallerObjectId", mscrmCallerId: "MSCRMCallerID" },
    body: httpMethod === "POST" ? "json" : null,
    bodyRequired: httpMethod === "POST",
    response: "json",
    pageable: false,
    change: null,
  }) satisfies RestOperation & { change: null };

/** The inputs every search call takes. */
type SearchInput = {
  /** The environment's host, such as `contoso.api.crm4.dynamics.com`, as `listEnvironments` returns it. */
  environment: string;
  /** The Microsoft Entra object ID of a user to act for. */
  callerObjectId?: string;
  /** The `systemuserid` of a user to act for. */
  mscrmCallerId?: string;
};

type Body<Method extends "searchquery" | "searchsuggest" | "searchautocomplete"> = Parameters<
  DataverseApi[Method]
>[0]["body"];

export type SearchResult = Promise<DataverseResult<{ [key: string]: JsonValue }>>;

const search = (
  environment: Environment,
  properties: DataverseProperties,
  method: string,
  httpMethod: "GET" | "POST",
  path: string,
  input: Arguments,
): SearchResult =>
  runOperation(
    environment,
    properties,
    method,
    searchOperation(httpMethod, path),
    searchBase,
    input,
  );

/** The methods of Dataverse search's endpoint, `/api/search/v2.0`. */
export const searchMethods = (environment: Environment, properties: DataverseProperties) => ({
  query: (input: SearchInput & { body: Body<"searchquery"> }) =>
    search(environment, properties, "searchV2Query", "POST", "/query", input),
  suggest: (input: SearchInput & { body: Body<"searchsuggest"> }) =>
    search(environment, properties, "searchV2Suggest", "POST", "/suggest", input),
  autocomplete: (input: SearchInput & { body: Body<"searchautocomplete"> }) =>
    search(environment, properties, "searchV2Autocomplete", "POST", "/autocomplete", input),
  statistics: (input: SearchInput) =>
    search(environment, properties, "searchV2Statistics", "GET", "/statistics", input),
  status: (input: SearchInput) =>
    search(environment, properties, "searchV2Status", "GET", "/status", input),
});
