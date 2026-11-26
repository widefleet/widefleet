import { WorkerEntrypoint } from "cloudflare:workers";
import { DataverseApi } from "./api.ts";
import type { ApprovalLevel } from "./approval.ts";
import { changeApprovalLevel, readApprovalLevel, saveApprovalLevel } from "./approval-methods.ts";
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
 * `createRow`, `updateRow` and `deleteRow`, addressed by the table's entity set,
 * its plural name such as `accounts`. Columns use their logical names; lookup
 * columns read as `_<name>_value` and are set with `<navigation
 * property>@odata.bind`, such as `"parentcustomerid_account@odata.bind":
 * "/accounts(<id>)"`. `createRow` and `updateRow` answer the row when
 * `prefer` is `return=representation`. `updateRow` creates a missing row unless
 * `ifMatch` is `*`.
 *
 * Query options keep their OData names, such as `$select`, `$filter`, `$orderby`,
 * `$top` and `$expand`. A list with more rows carries `@odata.nextLink`: pass it
 * as `nextLink` to `listRows` to read the next page. A `prefer` of
 * `odata.include-annotations="*"` adds formatted values, such as option labels.
 *
 * Tables, columns, relationships and security roles are rows too: create them
 * with `createRow` on `EntityDefinitions`, `RelationshipDefinitions` and `roles`,
 * add privileges with `addPrivilegesRole` and assign roles with `associateRows`
 * on `systemuserroles_association`. Changes to tables take effect after
 * `publishXml`. `getMetadata` returns the environment's CSDL, which lists its
 * tables, columns, actions and functions; `callAction` calls an action a
 * solution adds, such as one named `msdyn_`.
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
