import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.runIf(process.env["RUN_LOCAL_TESTS"] === "1")("local quickstart", () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("signs in to management and the deployed app, then saves and retrieves a private photo", async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });

    try {
      const page = await context.newPage();
      await page.goto("http://localhost:25450");
      await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
      await page.getByRole("button", { name: /admin@example.test/ }).click();
      await expect
        .poll(() => page.getByRole("heading", { name: "Your apps", exact: true }).count())
        .toBe(1);
      await page.getByRole("link", { name: "Team Notes", exact: true }).click();
      const appLink = page.getByRole("link", { name: "Open app", exact: true });
      expect(await appLink.getAttribute("href")).toBe("https://team-notes.apps.localhost:25453/");

      const origin = "https://team-notes.apps.localhost:25453";

      const anonymous = await context.request.get(origin, {
        maxRedirects: 0,
        headers: { "x-auth-request-user": "forged" },
      });

      expect(anonymous.status()).toBe(302);
      await page.goto(origin);
      await page.getByRole("button", { name: /admin@example.test/ }).click();
      await expect
        .poll(() => page.getByRole("heading", { name: "Team-Notizen", exact: true }).count())
        .toBe(1);
      const note = `Quickstart verification ${crypto.randomUUID()}`;

      const photo = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=",
        "base64",
      );

      if (process.env["LOCAL_EXPECT_EXISTING_DATA"] === "1") {
        expect(await page.getByRole("article").count()).toBeGreaterThan(0);

        const previousPhoto = await page
          .getByRole("article")
          .first()
          .getByRole("img")
          .getAttribute("src");

        if (!previousPhoto) throw new Error("The restored note has no photo");
        expect(await (await context.request.get(`${origin}${previousPhoto}`)).body()).toEqual(
          photo,
        );
      }

      await page.getByLabel("Deine Notiz", { exact: true }).fill(note);
      await page
        .getByLabel("Ein Foto dazu", { exact: true })
        .setInputFiles({ name: "test.png", mimeType: "image/png", buffer: photo });
      await page.getByRole("button", { name: "Notiz teilen", exact: true }).click();
      await expect
        .poll(() => page.getByRole("status").textContent())
        .toContain("Deine Notiz wurde gespeichert");
      const article = page.getByRole("article").filter({ hasText: note });
      const imagePath = await article.getByRole("img").getAttribute("src");
      expect(imagePath).toMatch(/^\/photos\//);

      if (!imagePath) throw new Error("Saved note did not reference its photo");
      const image = await context.request.get(`${origin}${imagePath}`);
      expect(image.status()).toBe(200);
      expect(await image.body()).toEqual(photo);
      await page.reload();
      await expect.poll(() => page.getByText(note, { exact: true }).count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 45_000);
});
