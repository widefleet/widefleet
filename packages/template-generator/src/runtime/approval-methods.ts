// Shared by the generated templates: the template generator copies this file into
// each template's src. Edit it in packages/template-generator/src/runtime.
import { z } from "zod";
import {
  approvalAnswer,
  type ApprovalLevel,
  approvalLevel,
  type ApprovalQuestion,
  approvals,
  levelDescriptions,
  loosens,
  question,
} from "./approval.ts";
import { caller, callerId, type Environment, type Properties } from "./context.ts";
import { initialize } from "./database.ts";

/** A result other than a question, which has no `resultType`. */
type Answered<R> = R & { resultType?: undefined };

type AnsweringProperties = Properties & { input?: z.input<typeof approvalAnswer> };

const signedIn = async (environment: Environment, properties: Properties) => {
  const identity = caller.safeParse(properties.caller);

  if (!identity.success) return null;
  await initialize(environment.DB);

  return approvals(environment.DB, await callerId(identity.data));
};

/** The current user's approval level. */
export const readApprovalLevel = async (
  environment: Environment,
  properties: Properties,
): Promise<
  Answered<{ status: "signed_in"; level: ApprovalLevel } | { status: "authentication_required" }>
> => {
  const user = await signedIn(environment, properties);

  if (!user) return { status: "authentication_required" };

  return { status: "signed_in", level: await user.level() };
};

/** Sets the current user's level. Asking less asks the user to confirm. */
export const changeApprovalLevel = async (
  service: string,
  environment: Environment,
  properties: AnsweringProperties,
  input: { level: ApprovalLevel },
): Promise<
  | ApprovalQuestion
  | Answered<
      | { status: "updated"; level: ApprovalLevel }
      | { status: "declined" }
      | { status: "authentication_required" }
    >
> => {
  const { level } = z.strictObject({ level: approvalLevel }).parse(input);
  const user = await signedIn(environment, properties);

  if (!user) return { status: "authentication_required" };
  const current = await user.level();

  if (loosens(current, level)) {
    const answer = approvalAnswer.parse(properties.input)?.inputResponses.approve;

    if (!answer)
      return question(
        `Ask less before ${service} changes run?\n\nNow: ${levelDescriptions[current]}\nNew: ${levelDescriptions[level]}`,
      );

    if (answer.action !== "accept") return { status: "declined" };
  }

  await user.set(level);

  return { status: "updated", level };
};

/**
 * Saves the level a user chooses on the app's page, or returns null for other
 * requests. The user chooses in person, so no further question is asked.
 */
export const saveApprovalLevel = async (
  environment: Environment,
  properties: Properties,
  request: Request,
) => {
  const url = new URL(request.url);

  if (url.pathname !== "/approval-level" || request.method !== "POST") return null;

  if (request.headers.get("origin") !== environment.WIDEFLEET_ORIGIN)
    return new Response("Invalid origin", { status: 403 });
  const user = await signedIn(environment, properties);

  if (!user) return new Response(null, { status: 401 });

  const level = approvalLevel.safeParse(new URLSearchParams(await request.text()).get("level"));

  if (!level.success) return new Response("Unknown approval level", { status: 400 });
  await user.set(level.data);

  return Response.json({ level: level.data });
};
