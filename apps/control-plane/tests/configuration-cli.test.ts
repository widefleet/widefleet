import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe.runIf(process.env["RUN_CLI_TESTS"] === "1")("native CLI configuration", () => {
  let directory: string;

  const binary = resolve(
    process.env["CLI_BINARY"] ??
      `target/debug/widefleet${process.platform === "win32" ? ".exe" : ""}`,
  );

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "widefleet config "));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const cli = (args: string[], environment: NodeJS.ProcessEnv = {}) =>
    execute(binary, args, {
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: join(directory, "home"),
        APPDATA: join(directory, "roaming"),
        PROGRAMDATA: join(directory, "managed"),
        XDG_CONFIG_HOME: join(directory, "xdg"),
        PLATFORM_CONFIG_FILE: undefined,
        PLATFORM_URL: undefined,
        WIDEFLEET_TELEMETRY_DISABLED: "1",
        ...environment,
      },
    });

  it("uses the native user location and gives explicit flags precedence over the environment", async () => {
    const file =
      process.platform === "win32"
        ? join(directory, "roaming", "widefleet", "config.json")
        : process.platform === "darwin"
          ? join(directory, "home", "Library", "Application Support", "widefleet", "config.json")
          : join(directory, "xdg", "widefleet", "config.json");

    await cli(["config", "set-url", "https://saved.example.test"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      platform_url: "https://saved.example.test",
    });
    expect(JSON.parse((await cli(["config", "show"])).stdout)).toMatchObject({
      config_file: file,
      platform_url: "https://saved.example.test",
      source: "user",
    });
    const environment = { PLATFORM_URL: "https://environment.example.test" };

    expect(JSON.parse((await cli(["config"], environment)).stdout)).toMatchObject({
      platform_url: "https://environment.example.test",
      source: "override",
    });
    expect(
      JSON.parse((await cli(["--url", "https://flag.example.test", "config"], environment)).stdout),
    ).toMatchObject({ platform_url: "https://flag.example.test", source: "override" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      platform_url: "https://saved.example.test",
    });
  });

  it("isolates explicit configuration files and lets the file flag override its environment", async () => {
    await cli(["config", "set-url", "https://default.example.test"]);
    const config = join(directory, "selected.json");
    const alternate = join(directory, "alternate.json");
    const environment = { PLATFORM_CONFIG_FILE: config };

    expect(JSON.parse((await cli(["config"], environment)).stdout)).toMatchObject({
      platform_url: null,
      managed_config_file: null,
    });
    await cli(["config", "set-url", "https://selected.example.test"], environment);
    await cli(
      ["--config-file", alternate, "config", "set-url", "https://alternate.example.test"],
      environment,
    );
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      platform_url: "https://selected.example.test",
    });
    expect(JSON.parse(await readFile(alternate, "utf8"))).toEqual({
      platform_url: "https://alternate.example.test",
    });
    await cli(["config", "unset-url"], environment);
    expect(JSON.parse((await cli(["config"], environment)).stdout)).toMatchObject({
      platform_url: null,
    });
    expect(JSON.parse((await cli(["config"])).stdout)).toMatchObject({
      platform_url: "https://default.example.test",
    });
  });

  it("rejects malformed configuration and preserves the last valid URL on an invalid update", async () => {
    const config = join(directory, "config.json");
    const environment = { PLATFORM_CONFIG_FILE: config };

    await cli(["config", "set-url", "https://saved.example.test"], environment);
    await expect(
      cli(["config", "set-url", "http://insecure.example.test"], environment),
    ).rejects.toThrow("Use an HTTPS platform origin");
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      platform_url: "https://saved.example.test",
    });
    await writeFile(config, "{");
    await expect(cli(["config"], environment)).rejects.toThrow("Invalid CLI configuration");
    expect(
      JSON.parse(
        (await cli(["--url", "https://explicit.example.test", "config"], environment)).stdout,
      ),
    ).toMatchObject({
      platform_url: "https://explicit.example.test",
    });
  });

  it.runIf(process.platform === "linux")("uses HOME when XDG_CONFIG_HOME is empty", async () => {
    await cli(["config", "set-url", "https://saved.example.test"], { XDG_CONFIG_HOME: "" });
    expect(
      JSON.parse(await readFile(join(directory, "home/.config/widefleet/config.json"), "utf8")),
    ).toEqual({
      platform_url: "https://saved.example.test",
    });
  });

  it.runIf(process.platform === "win32")(
    "uses the managed Windows default after clearing the user URL",
    async () => {
      const managed = join(directory, "managed", "widefleet", "config.json");
      const contents = JSON.stringify({ platform_url: "https://managed.example.test" });

      await mkdir(join(directory, "managed", "widefleet"), { recursive: true });
      await writeFile(managed, contents);
      expect(JSON.parse((await cli(["config"])).stdout)).toMatchObject({
        platform_url: "https://managed.example.test",
        source: "managed",
        managed_config_file: managed,
      });
      await cli(["config", "set-url", "https://user.example.test"]);
      expect(JSON.parse((await cli(["config", "unset-url"])).stdout)).toMatchObject({
        platform_url: "https://managed.example.test",
        source: "managed",
      });
      expect(await readFile(managed, "utf8")).toBe(contents);
    },
  );
});
