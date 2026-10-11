import { createServer } from "node:http";
import { startAppAuthorizer } from "../../tools/app-authorizer.ts";

// Synthetic sign-in endpoint; authorization uses the production authorizer.
createServer((request, response) => {
  const group = request.headers.cookie?.match(/(?:^|;\s*)fixture=([^;]+)/)?.[1];
  response.statusCode = group ? 202 : 401;

  if (group) {
    response.setHeader("X-Auth-Request-User", "synthetic-user");
    response.setHeader("X-Auth-Request-Groups", group);
  }

  response.end();
}).listen(4180, "127.0.0.1");

startAppAuthorizer(() => process.env["FIXTURE_ISSUER"] ?? null);
