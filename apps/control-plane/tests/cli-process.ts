import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import { onTestFinished } from "vitest";

const execute = promisify(execFile);

// A timed-out test must not keep sending requests after the next test resets
// the shared API fixture. Register cleanup for each command, including failures.
export function executeCli(
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) {
  const operation = execute(file, args, options);
  onTestFinished(async () => {
    if (operation.child.exitCode === null && operation.child.signalCode === null)
      operation.child.kill("SIGKILL");
    await operation.catch(() => undefined);
  });

  return operation;
}
