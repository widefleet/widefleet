import { WorkerEntrypoint } from "cloudflare:workers";
import { DataverseApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
import { batch, type BatchInput } from "./batch.ts";
import { searchMethods } from "./search.ts";
import { accountConnection } from "./connection.ts";
import type { Environment, Properties } from "./context.ts";

/**
 * Use Microsoft Dataverse as the current user. Every method takes the
 * environment's host as `environment`, such as `contoso.api.crm4.dynamics.com`;
 * `listEnvironments` lists those the user can open. Dataverse applies the
 * user's security roles there. Each action and
 * function of the Web API is a method. Reading never asks; methods that create,
 * change, delete or send ask the user first according to their approval level.
 *
 * @remarks
 * Rows of every table are read and changed with `listRows`, `getRow`,
 * `createRow`, `updateRow`, `deleteRow` and `countRows`, addressed by the
 * table's entity set, its plural name such as `accounts`. Columns use their
 * logical names; lookup columns read as `_<name>_value` and are set with
 * `<navigation property>@odata.bind`, such as
 * `"parentcustomerid_account@odata.bind": "/accounts(<id>)"`. A created row's
 * address is in the result's `headers` as `OData-EntityId`. Its address may
 * name an action as well as a table, so `createRow` asks like an action. `createRow` and
 * `updateRow` answer the row itself when `prefer` is `return=representation`.
 * `updateRow` creates a missing row unless `ifMatch` is `*`. An `id` is the
 * row's ID or an alternate key, such as `accountnumber='A-1'`, and for an
 * elastic table's row `<key>=<id>,partitionid='<partition>'`.
 *
 * Query options keep their OData names, such as `$select`, `$filter`, `$orderby`,
 * `$top` and `$expand`, and so do the headers, such as `prefer`, `consistency`
 * or `callerObjectId`. A list with more rows carries `@odata.nextLink`: pass it
 * as `nextLink` to read the next page. A `prefer` of
 * `odata.include-annotations="*"` adds formatted values, such as option labels,
 * and one of `odata.track-changes` a `@odata.deltaLink`, which `nextLink` later
 * reads the changes since. `listRows` runs a system view with `savedQuery` and
 * one the user saved with `userQuery`.
 *
 * One column is read with `getColumn`, set with `setColumn` and cleared with
 * `deleteColumn`. `getColumnContent` reads a file or image column's content and
 * `uploadColumnContent` uploads it as `application/octet-stream`, at once or,
 * with `transferMode` `chunked`, in chunks to the `Location` its answer names.
 *
 * The rows a row relates to through a navigation property, such as an account's
 * `contact_customer_accounts`, are read with `listRelatedRows`,
 * `getRelatedRow` and `countRelatedRows`, created with `createRelatedRow`, whose
 * answer names no new row, and
 * replaced and deleted with `replaceRelatedRow` and `deleteRelatedRow`.
 * `associateRows`, `setReference`, `disassociateRows` and
 * `disassociateRelatedRow` link and unlink rows; `listReferences` lists the
 * linked rows' addresses.
 *
 * Tables, relationships and security roles are rows too: create them with
 * `createRow` on `EntityDefinitions`, `RelationshipDefinitions` and `roles`. A
 * table's columns are the related rows `Attributes` of `EntityDefinitions` with
 * the `id` `LogicalName='<table>'`, one of them with the `relatedId`
 * `LogicalName='<column>'`. A choice column's options are read with `type`
 * `Microsoft.Dynamics.CRM.PicklistAttributeMetadata` and `$expand` `OptionSet`.
 * Definitions change only as a whole: read one, change it and pass it to
 * `replaceRow` or `replaceRelatedRow` with `mergeLabels` `true`, keeping its
 * `@odata.type` or naming it as `type`. Name the
 * solution of a new table or column with `solutionUniqueName`; changes take
 * effect after `publishXml`, and `consistency` `Strong` reads them at once. Add
 * privileges with `addPrivilegesRole` and assign roles with `associateRows` on
 * `systemuserroles_association`. `getServiceDocument` lists the entity sets and
 * `getMetadata` returns the environment's whole CSDL.
 *
 * Actions and functions that solutions add, such as those named `msdyn_`, are
 * called with `callAction` and `callFunction`, and those bound to a table or row
 * with `callTableAction`, `callRowAction`, `callTableFunction` and
 * `callRowFunction`, by their name with the namespace
 * `Microsoft.Dynamics.CRM.`. `batch` runs many requests in one call, and those
 * of a change set together or not at all. Dataverse search is also offered at
 * its own endpoint as `searchV2Query` and the other `searchV2` methods.
 *
 * @example
 * ```ts
 * const open = await env.DATAVERSE.listRows({
 *   environment: "contoso.api.crm4.dynamics.com",
 *   entitySet: "accounts",
 *   $select: ["name", "accountnumber"],
 *   $filter: "statecode eq 0",
 *   $top: 10,
 * });
 * if (open.status === "connected") {
 *   for (const row of open.data.value ?? []) console.log(row["name"]);
 * }
 * ```
 */
export default class Dataverse extends DataverseApi {
  /** Check account setup and linking. Connect the Microsoft account on this app's page. */
  async connectionStatus() {
    return accountConnection(this.env, this.ctx.props).status();
  }

  /** The Dataverse environments the user can open, with the host each method takes. */
  async listEnvironments() {
    return accountConnection(this.env, this.ctx.props).environments();
  }

  /**
   * Run up to 1000 requests in one call, as Dataverse's `$batch`. The requests
   * of a `changeSet` all take effect or none do; a later request of the set
   * refers to the row an earlier one created as `$<contentId>`. A batch that
   * changes data asks once, for all its changes. The answers come in the order
   * of the requests.
   */
  async batch(input: BatchInput) {
    return batch(this.env, this.ctx.props, input);
  }

  /**
   * Search rows of many tables at once through Dataverse search's endpoint,
   * `/api/search/v2.0/query`, with the body `searchquery` takes.
   */
  async searchV2Query(input: Parameters<ReturnType<typeof searchMethods>["query"]>[0]) {
    return searchMethods(this.env, this.ctx.props).query(input);
  }

  /** Suggest rows as a search is typed, at `/api/search/v2.0/suggest`, with the body `searchsuggest` takes. */
  async searchV2Suggest(input: Parameters<ReturnType<typeof searchMethods>["suggest"]>[0]) {
    return searchMethods(this.env, this.ctx.props).suggest(input);
  }

  /** Complete a search as it is typed, at `/api/search/v2.0/autocomplete`, with the body `searchautocomplete` takes. */
  async searchV2Autocomplete(
    input: Parameters<ReturnType<typeof searchMethods>["autocomplete"]>[0],
  ) {
    return searchMethods(this.env, this.ctx.props).autocomplete(input);
  }

  /** The size of the environment's search index, at `/api/search/v2.0/statistics`. */
  async searchV2Statistics(input: Parameters<ReturnType<typeof searchMethods>["statistics"]>[0]) {
    return searchMethods(this.env, this.ctx.props).statistics(input);
  }

  /** Whether search is set up and which tables it indexes, at `/api/search/v2.0/status`. */
  async searchV2Status(input: Parameters<ReturnType<typeof searchMethods>["status"]>[0]) {
    return searchMethods(this.env, this.ctx.props).status(input);
  }

  /** The current user's approval level, which decides when changes ask first. */
  async approvalLevel() {
    return readApprovalLevel(this.env, this.ctx.props);
  }

  /**
   * Set when the current user is asked before changes run. Asking more takes
   * effect at once; asking less asks the user to confirm.
   */
  async setApprovalLevel(input: { level: ApprovalLevel }) {
    return changeApprovalLevel("Dataverse", this.env, this.ctx.props, input);
  }

  override async fetch(request: Request) {
    return (
      (await saveApprovalLevel(this.env, this.ctx.props, request)) ??
      accountConnection(this.env, this.ctx.props).fetch(request)
    );
  }
}

/** Personal account controls used by Widefleet's My connections page. */
export class UserConnection extends WorkerEntrypoint<Environment, Properties> {
  async status() {
    return accountConnection(this.env, this.ctx.props).personalStatus();
  }

  async prepare(input: { completionUrl: string }) {
    return accountConnection(this.env, this.ctx.props).prepare(input);
  }

  async disconnect() {
    return accountConnection(this.env, this.ctx.props).disconnect();
  }
}
