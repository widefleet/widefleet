import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Exercise the real DNS API on disposable runners. Only this random .test zone
// gets a local resolver; the runner's default DNS configuration is unchanged.
export const createNativeResolver = async (
  directory: string,
  respond: (query: Buffer) => Promise<Buffer | undefined>,
) => {
  if (
    process.env["GITHUB_ACTIONS"] !== "true" ||
    process.env["RUNNER_ENVIRONMENT"] !== "github-hosted" ||
    !["darwin", "win32"].includes(process.platform)
  )
    throw new Error(
      "Native DNS fixtures require an isolated macOS or Windows GitHub-hosted runner",
    );

  const zone = `widefleet-${crypto.randomUUID()}.test`;
  const udp = createSocket("udp4");
  const tcp = createServer();
  const sockets = new Set<Socket>();
  const failures: unknown[] = [];
  let removeRule: (() => Promise<void>) | undefined;

  const close = async () => {
    try {
      await removeRule?.();
    } finally {
      for (const socket of sockets) socket.destroy();

      if (tcp.listening) await new Promise<void>((resolve) => tcp.close(() => resolve()));
      await new Promise<void>((resolve) => udp.close(() => resolve()));
    }

    if (failures.length) throw new AggregateError(failures, "Local DNS fixture failed");
  };

  udp.on("message", (query, peer) => {
    respond(query)
      .then((answer) => {
        if (answer) udp.send(answer, peer.port, peer.address);
      })
      .catch((cause: unknown) => failures.push(cause));
  });
  tcp.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A timed-out CLI exits while its OS may still have a TCP query outstanding.
    socket.on("error", () => socket.destroy());
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);

      while (pending.length >= 2) {
        const length = pending.readUInt16BE(0);

        if (pending.length < length + 2) break;
        const query = pending.subarray(2, length + 2);
        pending = pending.subarray(length + 2);
        respond(query)
          .then((answer) => {
            if (!answer || socket.destroyed) return;
            const prefix = Buffer.alloc(2);
            prefix.writeUInt16BE(answer.length);
            socket.write(Buffer.concat([prefix, answer]));
          })
          .catch((cause: unknown) => failures.push(cause));
      }
    });
  });
  udp.bind(process.platform === "win32" ? 53 : 0, "127.0.0.1");
  await once(udp, "listening");

  try {
    const { port } = udp.address();
    tcp.listen(port, "127.0.0.1");
    await once(tcp, "listening");

    if (process.platform === "darwin") {
      const source = join(directory, "resolver.conf");
      const destination = `/etc/resolver/${zone}`;
      await writeFile(source, `nameserver 127.0.0.1\nport ${port}\n`);
      removeRule = async () => {
        await execute("sudo", ["-n", "rm", "-f", destination]);
      };

      await execute("sudo", ["-n", "mkdir", "-p", "/etc/resolver"]);
      await execute("sudo", ["-n", "install", "-m", "644", source, destination]);

      for (let attempt = 0; ; attempt += 1) {
        const { stdout } = await execute("scutil", ["--dns"]);

        if (stdout.includes(zone)) break;

        if (attempt === 20) throw new Error("macOS did not register the test DNS resolver");
        await delay(250);
      }
    } else {
      const powershell = (script: string) =>
        execute("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
          env: { ...process.env, WIDEFLEET_TEST_DNS_ZONE: `.${zone}` },
          timeout: 15_000,
        });

      removeRule = async () => {
        await powershell(
          '$ErrorActionPreference = "Stop"; Get-DnsClientNrptRule | Where-Object { $_.Namespace -contains $env:WIDEFLEET_TEST_DNS_ZONE } | ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -Force }',
        );
      };

      await powershell(
        '$ErrorActionPreference = "Stop"; Add-DnsClientNrptRule -Namespace $env:WIDEFLEET_TEST_DNS_ZONE -NameServers "127.0.0.1"',
      );
    }

    return { zone, close };
  } catch (error) {
    await close();
    throw error;
  }
};
