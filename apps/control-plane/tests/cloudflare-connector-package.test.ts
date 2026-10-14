import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  connectorMigrations,
  connectorServiceBinding,
  connectorUpload,
  validateHostedConnector,
} from "../src/lib/server/cloudflare-connector-package.ts";
import { connectorFixture } from "./cloudflare-connector.fixture.ts";

describe("Hosted connector packages", () => {
  it("checks the shared secret limit before uploading native bindings", () => {
    const upload = (value: string) =>
      connectorUpload(
        "operation",
        "connector-worker",
        connectorFixture(),
        [],
        { API_KEY: value },
        null,
      );

    expect(() => upload("é".repeat(2500))).not.toThrow();
    expect(() => upload("é".repeat(2501))).toThrow("5000 UTF-8 bytes");
    expect(() => upload("x".repeat(5001))).toThrow("5000 UTF-8 bytes");
    expect(() => upload("")).toThrow();
  });
  it("uploads original code, native secrets, and a private service entrypoint together", async () => {
    const release = connectorFixture();

    const form = connectorUpload(
      "operation",
      "connector-worker",
      release,
      [],
      { API_KEY: "synthetic-only" },
      null,
    );

    const metadata = z
      .object({ main_module: z.string(), bindings: z.array(z.record(z.string(), z.json())) })
      .parse(JSON.parse(z.string().parse(form.get("metadata"))));

    expect(metadata.bindings).toContainEqual({
      type: "secret_text",
      name: "WIDEFLEET_SECRET_API_KEY",
      text: "synthetic-only",
    });
    expect(metadata.bindings).toContainEqual({
      type: "service",
      name: "WIDEFLEET_SECRETS",
      service: "connector-worker",
      entrypoint: "WIDEFLEET_SECRET_READER",
    });
    expect(metadata.bindings).not.toContainEqual(
      expect.objectContaining({ type: "plain_text", text: "synthetic-only" }),
    );
    const module = form.get("connector.js");

    if (!(module instanceof Blob)) throw new Error("Missing connector module");
    expect(await module.text()).toBe(release.modules[0]?.source);
  });
  it("scopes services to installations and maps only the default entrypoint", () => {
    const first = connectorServiceBinding("fleet-a", "erp", "default");
    const second = connectorServiceBinding("fleet-b", "erp", "default");
    expect(first.service).not.toBe(second.service);
    expect(first.name).not.toBe(second.name);
    expect(first.entrypoint).toBe("WIDEFLEET_CONNECTOR");
    expect(connectorServiceBinding("fleet-a", "erp", "Reader")).toMatchObject({
      service: first.service,
      entrypoint: "Reader",
    });
  });
  it("applies only new Durable Object migrations and rejects missing history", () => {
    const release = connectorFixture();
    release.configuration.migrations.push({ tag: "v2", new_sqlite_classes: ["Other"] });
    expect(connectorMigrations(release, "v1")).toEqual({
      old_tag: "v1",
      new_tag: "v2",
      steps: [{ new_sqlite_classes: ["Other"] }],
    });
    expect(connectorMigrations(release, "v2")).toBeUndefined();
    expect(() => connectorMigrations(release, "unknown")).toThrow("migration history");
    release.configuration.migrations.push({ tag: "v2", new_sqlite_classes: [] });
    expect(() => validateHostedConnector(release, [])).toThrow("unique tags");
  });
  it("counts variables and secrets against the native per-worker limit", () => {
    const release = connectorFixture();
    expect(() =>
      validateHostedConnector(
        release,
        Array.from({ length: 127 }, (_, i) => `SECRET_${i}`),
      ),
    ).not.toThrow();
    expect(() =>
      validateHostedConnector(
        release,
        Array.from({ length: 128 }, (_, i) => `SECRET_${i}`),
      ),
    ).toThrow("128");
  });
});
