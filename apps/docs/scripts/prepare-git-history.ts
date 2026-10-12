import { execFileSync } from "node:child_process";

// A shallow boundary makes unchanged pages look newly modified to Blume.
const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
  encoding: "utf8",
}).trim();

if (shallow === "true") {
  execFileSync("git", ["fetch", "--unshallow", "--no-tags", "origin"], { stdio: "inherit" });
}
