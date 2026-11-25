import { and, eq, inArray, notLike } from "drizzle-orm";
import { z } from "zod";
import { profileImagePath } from "@platform/contracts";
import { organizationRole, organizationRoles } from "../organization.ts";
import { member, user } from "./auth-schema.ts";
import type { Authentication } from "./auth.ts";
import type { DatabaseExecutor } from "./database.ts";
import { pictureVersion, type PictureResult } from "@platform/auth-proxy/picture";
import { userPictures } from "./schema.ts";

// `user.image` names Widefleet's copy, never a provider URL. Without a readable picture,
// the copy stays; a provider that reports none removes it.
export const saveUserPicture = async (
  database: DatabaseExecutor,
  userId: string,
  picture: PictureResult,
) => {
  const version = picture && picture !== "none" ? await pictureVersion(picture) : null;

  // Concurrent sign-ins of one person take turns, so the row and `user.image` agree.
  await database.transaction(async (transaction) => {
    await transaction.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");

    if (picture === null) {
      // Better Auth stores the provider URL at sign-up. Pages never load it.
      await transaction
        .update(user)
        .set({ image: null })
        .where(and(eq(user.id, userId), notLike(user.image, "/users/%")));

      return;
    }

    if (picture === "none" || version === null) {
      await transaction.delete(userPictures).where(eq(userPictures.userId, userId));
      await transaction.update(user).set({ image: null }).where(eq(user.id, userId));

      return;
    }

    await transaction
      .insert(userPictures)
      .values({ userId, ...picture, version, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userPictures.userId,
        set: { ...picture, version, updatedAt: new Date() },
      });
    await transaction
      .update(user)
      .set({ image: profileImagePath(userId, version) })
      .where(eq(user.id, userId));
  });
};

/**
 * A person's own picture is always visible to them. Others see it where they may list
 * the person as a member: as an administrator of an organization both belong to.
 */
export const readUserPicture = async (
  database: DatabaseExecutor,
  viewer: { id: string; organizations: { id: string; role: string; ssoRequired: boolean }[] },
  userId: string,
) => {
  if (viewer.id !== userId) {
    const administered = viewer.organizations.flatMap((organization) => {
      const role = organizationRole.safeParse(organization.role);

      return !organization.ssoRequired &&
        role.success &&
        organizationRoles[role.data].authorize({ agent: ["manage"] }).success
        ? [organization.id]
        : [];
    });

    if (!administered.length) return null;

    const [shared] = await database
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.userId, userId), inArray(member.organizationId, administered)))
      .limit(1);

    if (!shared) return null;
  }

  const [picture] = await database
    .select({
      bytes: userPictures.bytes,
      contentType: userPictures.contentType,
      version: userPictures.version,
    })
    .from(userPictures)
    .where(eq(userPictures.userId, userId));

  return picture ?? null;
};

/**
 * App sign-in through Widefleet names a person's picture URL as their `picture` claim. The app
 * proxy fetches it with that sign-in's access token, which may read only its own subject.
 */
export const tokenViewer = (auth: Authentication, headers: Headers) =>
  auth.api
    .oauth2UserInfo({ headers })
    .then((claims) => ({ id: z.string().parse(claims.sub), organizations: [] }))
    .catch(() => null);
