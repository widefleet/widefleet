import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { LinearApi } from "./api.ts";
import {
  approvalAnswer,
  type ApprovalQuestion,
  type ApprovalLevel,
  approvalLevel,
  approvals,
  levelDescriptions,
  loosens,
  question,
} from "./approval.ts";
import { accountConnection } from "./connection.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { initialize } from "./database.ts";
import type { Answered } from "./results.ts";

const signedIn = async (environment: Environment, properties: Properties) => {
  const identity = caller.safeParse(properties.caller);

  if (!identity.success) return null;
  await initialize(environment.DB);

  return approvals(environment.DB, await callerId(identity.data));
};

/**
 * Use the current user's Linear workspace through Linear's GraphQL API. Each
 * query and mutation is a method. Queries read without asking; mutations ask the
 * user first according to their approval level.
 */
export default class Linear extends LinearApi {
  /** Check account setup and linking. Connect the Linear account on this app's page. */
  async connectionStatus() {
    return accountConnection(this.env, this.ctx.props).status();
  }

  /** The current user's approval level, which decides when changes ask first. */
  async approvalLevel(): Promise<
    Answered<{ status: "signed_in"; level: ApprovalLevel } | { status: "authentication_required" }>
  > {
    const user = await signedIn(this.env, this.ctx.props);

    if (!user) return { status: "authentication_required" };

    return { status: "signed_in", level: await user.level() };
  }

  /**
   * Set when the current user is asked before changes run. Asking more takes
   * effect at once; asking less asks the user to confirm.
   */
  async setApprovalLevel(input: {
    level: ApprovalLevel;
  }): Promise<
    | ApprovalQuestion
    | Answered<
        | { status: "updated"; level: ApprovalLevel }
        | { status: "declined" }
        | { status: "authentication_required" }
      >
  > {
    const { level } = z.strictObject({ level: approvalLevel }).parse(input);
    const user = await signedIn(this.env, this.ctx.props);

    if (!user) return { status: "authentication_required" };
    const current = await user.level();

    if (loosens(current, level)) {
      const answer = approvalAnswer.parse(this.ctx.props.input)?.inputResponses.approve;

      if (!answer)
        return question(
          `Ask less before Linear changes run?\n\nNow: ${levelDescriptions[current]}\nNew: ${levelDescriptions[level]}`,
        );

      if (answer.action !== "accept") return { status: "declined" };
    }

    await user.set(level);

    return { status: "updated", level };
  }

  override async fetch(request: Request) {
    const url = new URL(request.url);

    // The user chooses on their own page, so no further question is asked.
    if (url.pathname === "/approval-level" && request.method === "POST") {
      if (request.headers.get("origin") !== this.env.WIDEFLEET_ORIGIN)
        return new Response("Invalid origin", { status: 403 });
      const user = await signedIn(this.env, this.ctx.props);

      if (!user) return new Response(null, { status: 401 });

      const level = approvalLevel.safeParse(new URLSearchParams(await request.text()).get("level"));

      if (!level.success) return new Response("Unknown approval level", { status: 400 });
      await user.set(level.data);

      return Response.json({ level: level.data });
    }

    return accountConnection(this.env, this.ctx.props).fetch(request);
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
