import type { Artifacts, ArtifactsRepo } from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";
import { createArtifactsSource } from "../src/lib/server/source-artifacts.ts";

const fixture = () => {
  const info = {
    id: "repo-id",
    name: "app-id",
    description: null,
    defaultBranch: "main",
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    lastPushAt: null,
    source: null,
    readOnly: false,
    remote: "https://git.example.test/widefleet/app-id.git",
  };

  const token = {
    id: "token-id",
    plaintext: "art_v1_test?expires=1800000000",
    scope: "read" as const,
    expiresAt: "2027-01-15T08:00:00.000Z",
  };

  const repo = {
    [Symbol.dispose]: vi.fn(),
    info: vi.fn<ArtifactsRepo["info"]>().mockResolvedValue(info),
    createToken: vi.fn<ArtifactsRepo["createToken"]>().mockResolvedValue(token),
    revokeToken: vi.fn<ArtifactsRepo["revokeToken"]>().mockResolvedValue(true),
    listTokens: vi.fn<ArtifactsRepo["listTokens"]>(),
    readBlob: vi.fn<ArtifactsRepo["readBlob"]>(),
    readTree: vi.fn<ArtifactsRepo["readTree"]>(),
    readCommit: vi.fn<ArtifactsRepo["readCommit"]>().mockResolvedValue(null),
    readFile: vi.fn<ArtifactsRepo["readFile"]>(),
    log: vi.fn<ArtifactsRepo["log"]>().mockResolvedValue([]),
    fork: vi.fn<ArtifactsRepo["fork"]>(),
  } satisfies ArtifactsRepo;

  const binding = {
    get: vi.fn<Artifacts["get"]>().mockResolvedValue(repo),
    create: vi.fn<Artifacts["create"]>().mockResolvedValue({
      id: info.id,
      name: info.name,
      description: null,
      defaultBranch: "main",
      remote: info.remote,
      token: "initial-token",
    }),
    delete: vi.fn<Artifacts["delete"]>().mockResolvedValue(true),
    import: vi.fn<Artifacts["import"]>(),
    list: vi.fn<Artifacts["list"]>(),
  } satisfies Artifacts;

  return { binding, repo, info, token, source: createArtifactsSource(binding) };
};

describe("Artifacts source backend", () => {
  it("revokes the initial credential and issues scoped short-lived Git credentials", async () => {
    const { binding, repo, info, source } = fixture();
    expect(await source.create("id")).toEqual({ url: info.remote });
    expect(binding.create).toHaveBeenCalledWith("app-id", { setDefaultBranch: "main" });
    expect(repo.revokeToken).toHaveBeenCalledWith("initial-token");
    expect(repo[Symbol.dispose]).toHaveBeenCalledTimes(1);
    expect(await source.credential("id", "read")).toEqual({
      url: info.remote,
      username: "x",
      password: "art_v1_test",
      expiresAt: "2027-01-15T08:00:00.000Z",
    });
    expect(repo.createToken).toHaveBeenLastCalledWith("read", 300);
    await source.credential("id", "write");
    expect(repo.createToken).toHaveBeenLastCalledWith("write", 300);
    expect(repo[Symbol.dispose]).toHaveBeenCalledTimes(3);
  });

  it("only treats NOT_FOUND as an absent repository and releases handles on failures", async () => {
    const { binding, repo, source } = fixture();
    binding.get.mockRejectedValueOnce(Object.assign(new Error("Not found"), { code: "NOT_FOUND" }));
    expect(await source.repository("id")).toBeNull();
    binding.get.mockRejectedValueOnce(
      Object.assign(new Error("Unavailable"), { code: "UPSTREAM_UNAVAILABLE" }),
    );
    await expect(source.repository("id")).rejects.toThrow("Unavailable");
    repo.info.mockRejectedValueOnce(new Error("Could not read"));
    await expect(source.repository("id")).rejects.toThrow("Could not read");
    expect(repo[Symbol.dispose]).toHaveBeenCalledTimes(1);
  });

  it("looks up full branch refs, verifies commit presence, and deletes idempotently", async () => {
    const { binding, repo, source } = fixture();
    expect(await source.head("id", "preview/search")).toBeNull();
    expect(repo.log).toHaveBeenCalledWith({ ref: "refs/heads/preview/search", limit: 1 });
    expect(await source.hasCommit("id", "a".repeat(40))).toBe(false);
    expect(repo.readCommit).toHaveBeenCalledWith("a".repeat(40));
    binding.get.mockRejectedValueOnce(Object.assign(new Error("Not found"), { code: "NOT_FOUND" }));
    expect(await source.hasCommit("missing", "a".repeat(40))).toBe(false);
    repo.readCommit.mockRejectedValueOnce(new Error("Could not read"));
    await expect(source.hasCommit("id", "a".repeat(40))).rejects.toThrow("Could not read");
    await source.remove("id");
    binding.delete.mockResolvedValue(false);
    await source.remove("id");
    expect(binding.delete).toHaveBeenCalledTimes(2);
  });
});
