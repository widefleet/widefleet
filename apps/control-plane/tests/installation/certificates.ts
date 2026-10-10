import { execFile } from "node:child_process";
import { generateKeyPair } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

const generate = promisify(generateKeyPair);

export const createCertificates = async (directory: string, extraDomains: string[] = []) => {
  const ca = join(directory, "ca.pem");
  const key = join(directory, "server.key");
  const certificate = join(directory, "server.pem");
  const accountKey = join(directory, "account.key");
  await chmod(directory, 0o755);
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "365",
    "-subj",
    "/CN=Installation Test CA",
    "-keyout",
    join(directory, "ca.key"),
    "-out",
    ca,
  ]);
  await execute("openssl", [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=platform.example.test",
    "-keyout",
    key,
    "-out",
    join(directory, "server.csr"),
  ]);
  const extensions = join(directory, "extensions.cnf");
  await writeFile(
    extensions,
    `subjectAltName=${["localhost", "platform.example.test", "*.apps.example.test", "graph.microsoft.com", "oidc.localhost", ...extraDomains].map((domain) => `DNS:${domain}`).join(",")}\nextendedKeyUsage=serverAuth\n`,
  );
  await execute("openssl", [
    "x509",
    "-req",
    "-in",
    join(directory, "server.csr"),
    "-CA",
    ca,
    "-CAkey",
    join(directory, "ca.key"),
    "-CAcreateserial",
    "-out",
    certificate,
    "-days",
    "90",
    "-extfile",
    extensions,
  ]);

  const { privateKey } = await generate("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  await writeFile(accountKey, privateKey, { mode: 0o600 });

  return { ca, key, certificate, accountKey };
};
