import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { member, organization, user } from "../src/lib/server/auth-schema.ts";
import { userPictures } from "../src/lib/server/schema.ts";
import { readUserPicture, saveUserPicture } from "../src/lib/server/user-pictures.ts";
import { createTestEnvironment } from "./environment.ts";

let environment: Awaited<ReturnType<typeof createTestEnvironment>>;

beforeAll(async () => {
  environment = await createTestEnvironment();
});

afterAll(async () => environment?.close());

const picture = (marker: number) => ({
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker]),
  contentType: "image/png",
});

const person = async (email: string) => {
  const created = environment.users.createUser({ email, name: email, emailVerified: true });
  await environment.users.saveUser(created);

  return created.id;
};

const team = async (members: [userId: string, role: "owner" | "admin" | "member"][]) => {
  const id = crypto.randomUUID();
  const database = environment.database.db;
  await database.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
  await database.insert(member).values(
    members.map(([userId, role]) => ({
      id: crypto.randomUUID(),
      organizationId: id,
      userId,
      role,
      createdAt: new Date(),
    })),
  );

  return id;
};

const imageOf = async (userId: string) =>
  (
    await environment.database.db
      .select({ image: user.image })
      .from(user)
      .where(eq(user.id, userId))
  )[0]?.image;

it("keeps one copy per person and names it in the user row", async () => {
  const database = environment.database.db;
  const userId = await person("copied@example.test");

  await database
    .update(user)
    .set({ image: "https://provider.example.test/photo" })
    .where(eq(user.id, userId));
  // A provider URL from sign-up is never kept without a copy.
  await saveUserPicture(database, userId, null);
  expect(await imageOf(userId)).toBeNull();

  await saveUserPicture(database, userId, picture(1));
  const first = await imageOf(userId);
  expect(first).toMatch(new RegExp(`^/users/${userId}/picture\\?v=[0-9a-f]{16}$`));

  // An unreadable picture keeps the copy; a new one replaces it under a new version.
  await saveUserPicture(database, userId, null);
  expect(await imageOf(userId)).toBe(first);
  await saveUserPicture(database, userId, picture(2));
  expect(await imageOf(userId)).not.toBe(first);
  expect(
    await database.select().from(userPictures).where(eq(userPictures.userId, userId)),
  ).toHaveLength(1);

  // A provider that reports no picture removes the copy.
  await saveUserPicture(database, userId, "none");
  expect(await imageOf(userId)).toBeNull();
  expect(await database.select().from(userPictures).where(eq(userPictures.userId, userId))).toEqual(
    [],
  );

  // Deleting the person deletes their picture.
  await saveUserPicture(database, userId, picture(3));
  await database.delete(user).where(eq(user.id, userId));
  expect(await database.select().from(userPictures).where(eq(userPictures.userId, userId))).toEqual(
    [],
  );
});

it("shows a picture to its owner and to administrators of a shared organization", async () => {
  const database = environment.database.db;
  const pictured = await person("pictured@example.test");
  const administrator = await person("administrator@example.test");
  const colleague = await person("colleague@example.test");
  const outsider = await person("outsider@example.test");

  const shared = await team([
    [pictured, "member"],
    [administrator, "admin"],
    [colleague, "member"],
  ]);

  const elsewhere = await team([[outsider, "owner"]]);

  await saveUserPicture(database, pictured, picture(4));

  const read = (
    viewer: string,
    organizations: { id: string; role: string; ssoRequired: boolean }[],
  ) => readUserPicture(database, { id: viewer, organizations }, pictured);

  expect(await read(pictured, [])).toMatchObject({ contentType: "image/png" });
  expect(
    await read(administrator, [{ id: shared, role: "admin", ssoRequired: false }]),
  ).toMatchObject({ contentType: "image/png" });
  // Members do not list each other, and a sign-in that cannot reach the organization does not count.
  expect(await read(colleague, [{ id: shared, role: "member", ssoRequired: false }])).toBeNull();
  expect(await read(administrator, [{ id: shared, role: "admin", ssoRequired: true }])).toBeNull();
  expect(await read(outsider, [{ id: elsewhere, role: "owner", ssoRequired: false }])).toBeNull();

  // Leaving the organization ends an administrator's view.
  await database.delete(member).where(eq(member.userId, pictured));
  expect(await read(administrator, [{ id: shared, role: "admin", ssoRequired: false }])).toBeNull();
});
