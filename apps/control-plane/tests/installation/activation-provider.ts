// A disposable HTTPS discovery endpoint for supervisor failure/recovery tests.
import { createServer } from "node:https";
import { readFile, writeFile } from "node:fs/promises";

const issuer = "https://localhost:4182";

const server = createServer(
  {
    key: await readFile("/runtime/server.key"),
    cert: await readFile("/runtime/server.pem"),
  },
  (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      }),
    );
  },
);

server.listen(4182, "127.0.0.1");

await writeFile("/runtime/provider.pid", String(process.pid));
