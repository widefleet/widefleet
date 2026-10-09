import { form, getRequestEvent, query } from "$app/server";
import { redirect } from "@sveltejs/kit";
import { z } from "zod";
import { changeMemberRole, listMembers, memberRoleInput } from "#server/members";
import { formValue, queryValue, remoteContext, remoteOperation } from "#server/remote-support";

const memberQuery = z.object({
  search: z.string().trim().max(200),
  page: z.number().int().min(1).max(100_000),
});

export const getMembers = query(memberQuery, async ({ search, page }) => {
  const { runtime, principal } = await remoteContext();

  const result = await remoteOperation(() =>
    listMembers(runtime.database.db, principal, search, page),
  );

  return { principal, ...queryValue(result) };
});

export const setMemberRole = form(
  memberRoleInput.extend({
    search: memberQuery.shape.search.default(""),
    page: z
      .string()
      .regex(/^[0-9]+$/)
      .default("1")
      .transform(Number)
      .pipe(memberQuery.shape.page),
  }),
  async ({ memberId, role, search, page }) => {
    const { runtime, principal, request } = await remoteContext(true);
    formValue(
      await remoteOperation(() =>
        changeMemberRole(runtime.auth, principal, request.headers, { memberId, role }),
      ),
    );
    await getMembers({ search, page }).refresh();

    if (!getRequestEvent().isRemoteRequest)
      redirect(
        303,
        `/members?${new URLSearchParams({ q: search, page: String(page), saved: "1" })}`,
      );

    return { saved: true };
  },
);
