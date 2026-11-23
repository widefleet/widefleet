// Checks whether agents find the Widefleet MCP server without being told to use it.
//
// ChatGPT and Codex load connected apps lazily: before the model looks inside an app it
// sees one line per app, and for MCP servers in plugins that line is the start of the
// server instructions. This script installs a stub server with the current instructions
// as a local Codex plugin, asks each prompt several times and reports whether the model's
// first MCP call goes to the stub. As in ChatGPT, the plugin directory competes with it:
// the model sees suggested plugins such as Linear and can search the directory. The
// account's connected apps are turned off so that results do not depend on the account,
// including a connected Widefleet app.
//
// Usage: node packages/app-runtime/mcp-discovery-eval.ts [--runs N]
// Needs the Codex CLI signed in with a ChatGPT account (codex login).
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { mcpInstructions } from "./src/mcp-skills.ts";

// A name of its own keeps the stub apart from Widefleet itself.
const product = "Testfleet";

const server = "testfleet";

const cases = [
  {
    prompt: "Which Linear issues in my workspace are still in Todo, and which teams am I in?",
    expected: "uses",
  },
  {
    prompt:
      "How many clicks did our website get in Google Search Console last week, and which queries led?",
    expected: "uses",
  },
  {
    prompt:
      "Build a small internal app where my team can submit vacation requests and I can approve or reject them. Only people from our company should be able to sign in. Put it online for everyone.",
    expected: "uses",
  },
  { prompt: "Write a short haiku about autumn.", expected: "ignores" },
  { prompt: "Explain the difference between TCP and UDP in two sentences.", expected: "ignores" },
] as const;

const tools = {
  skills: "List skills, or read one by name.",
  search: "Find methods of permitted app services by words in their names and documentation.",
  describe: "Read the documentation, signatures and types of methods found with search.",
  call: "Invoke a permitted app service with positional JSON arguments.",
  execute: "Run JavaScript that calls app services with tools.call and returns JSON.",
  cli_login: "Sign in the CLI as the current user.",
};

const serve = async () => {
  const stub = new McpServer(
    { name: product, version: "0.0.0" },
    {
      instructions: mcpInstructions
        .replaceAll("Widefleet", product)
        .replaceAll("widefleet", server),
    },
  );

  for (const [name, description] of Object.entries(tools))
    stub.registerTool(
      name,
      { description, inputSchema: { input: z.unknown().optional() } },
      // Ends the run as soon as the model has chosen the server.
      async () => ({
        isError: true,
        content: [{ type: "text" as const, text: "Unavailable. Tell the user and stop." }],
      }),
    );

  await stub.connect(new StdioServerTransport());
};

const run = promisify(execFile);

const script = fileURLToPath(import.meta.url);

const codex = (home: string, args: string[]) => {
  const command = run("codex", args, {
    cwd: home,
    env: { ...process.env, CODEX_HOME: home },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });

  // codex exec appends standard input to the prompt and waits for it to close.
  command.child.stdin?.end();

  return command;
};

const firstMcpServer = (output: string) => {
  for (const line of output.split("\n")) {
    const event = z
      .object({ type: z.string(), item: z.object({ type: z.string(), server: z.string() }) })
      .safeParse(JSON.parse(line || "null"));

    if (event.success && event.data.item.type === "mcp_tool_call") return event.data.item.server;
  }

  return null;
};

const evaluate = async (runs: number) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-discovery-eval-"));
  const auth = join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "auth.json");

  try {
    const plugin = join(root, "marketplace", "plugins", server);
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
    await mkdir(join(root, "marketplace", ".agents", "plugins"), { recursive: true });

    await writeFile(
      join(root, "marketplace", ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: "discovery-eval",
        plugins: [
          {
            name: server,
            source: { source: "local", path: `./plugins/${server}` },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Productivity",
          },
        ],
      }),
    );
    await writeFile(
      join(plugin, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: server, version: "0.0.0", mcpServers: "./.mcp.json" }),
    );
    await writeFile(
      join(plugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: { [server]: { command: process.execPath, args: [script, "serve"] } },
      }),
    );

    // Each run gets its own Codex home, because parallel runs share state files otherwise.
    const attempt = async (prompt: string, index: number) => {
      const home = join(root, `run-${index}`);
      await mkdir(home);
      await symlink(auth, join(home, "auth.json"));
      await writeFile(join(home, "config.toml"), "");
      await codex(home, ["plugin", "marketplace", "add", join(root, "marketplace")]);
      await codex(home, ["plugin", "add", `${server}@discovery-eval`]);

      const { stdout } = await codex(home, [
        "exec",
        "--config",
        "apps._default.enabled=false",
        "--config",
        "apps.connector_openai_plugin_management.enabled=true",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--json",
        prompt,
      ]);

      return firstMcpServer(stdout) === server;
    };

    let index = 0;

    const results = await Promise.all(
      cases.map(async (entry) => {
        const used = await Promise.all(
          Array.from({ length: runs }, () => attempt(entry.prompt, index++)),
        );

        const passed = used.filter((value) => value === (entry.expected === "uses")).length;

        return { ...entry, passed };
      }),
    );

    for (const { prompt, expected, passed } of results)
      console.log(`${passed}/${runs}  ${expected.padEnd(7)}  ${prompt}`);

    if (results.some(({ passed }) => passed < runs)) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: "string", default: "3" } },
});

if (positionals[0] === "serve") await serve();
else await evaluate(z.coerce.number().int().min(1).max(10).parse(values.runs));
