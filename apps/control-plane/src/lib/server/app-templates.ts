import { appTemplate, appTemplateCatalog } from "@platform/contracts";
import { Result } from "better-result";
import type { Principal } from "./identity.ts";
import type { Configuration } from "./config.ts";
import { InvalidOperation } from "./errors.ts";

const templates = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Search and read email and download attachments from your Gmail account.",
    capabilities: ["Search messages", "Read messages and headers", "Download attachments"],
    network: [
      "https://accounts.google.com",
      "https://oauth2.googleapis.com",
      "https://www.googleapis.com",
      "https://gmail.googleapis.com",
    ],
    secrets: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    setup:
      "An administrator enables Gmail API in Google Cloud, configures the OAuth consent screen and creates a Web application OAuth client. Register the callback URL shown on the app's setup page. For an external OAuth app in testing mode, add the accounts that will connect as test users. Each user then connects their own Google account. This app requests gmail.readonly access.",
    examples: [
      {
        description:
          "Connect a consuming app with widefleet connect gmail --as GMAIL. Search messages, then read one.",
        code: 'const result = await env.GMAIL.searchMessages({ query: "has:attachment", maxResults: 10 });\nif (result.status === "connected" && result.messages[0]) {\n  const message = await env.GMAIL.getMessage(result.messages[0].id);\n  // Handle message.status before using its data.\n}',
      },
    ],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Read repositories, issues and files, including private repositories.",
    capabilities: ["List repositories", "List repository issues", "Read repository files"],
    network: ["https://github.com", "https://api.github.com"],
    secrets: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
    setup:
      "An administrator registers a GitHub OAuth app and sets its authorization callback URL to the URL shown on the app's setup page. Each user then connects their own GitHub account. Private repository access requires GitHub's repo scope, which also grants write permissions; the supplied app exposes read methods.",
    examples: [
      {
        description:
          "Connect a consuming app with widefleet connect github --as GITHUB. Read a repository file.",
        code: 'const result = await env.GITHUB.readFile({\n  owner: "example", repository: "project", path: "README.md"\n});\nif (result.status === "connected") {\n  const text = new TextDecoder().decode(result.data);\n}',
      },
    ],
  },
  {
    id: "onedrive",
    name: "OneDrive",
    description: "Find files in your OneDrive and get temporary download links.",
    capabilities: ["List files and folders", "Search files", "Get temporary download links"],
    network: ["https://login.microsoftonline.com", "https://graph.microsoft.com"],
    secrets: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    setup:
      "An administrator registers a Microsoft Entra application. Choose Accounts in any organizational directory and personal Microsoft accounts to support both company and personal accounts. Add the callback URL shown on the app's setup page as a Web redirect URI and add the delegated Microsoft Graph permission Files.Read. Use the application client ID and the client secret's value, not its ID. Each user then connects their own Microsoft account. Download links grant temporary access to a file; open them in the browser and keep them out of logs.",
    examples: [
      {
        description:
          "Connect a consuming app with widefleet connect onedrive --as ONEDRIVE. List files and get a download link.",
        code: 'const result = await env.ONEDRIVE.listFiles();\nif (result.status === "connected") {\n  const file = result.files.find((item) => item.file);\n  if (file) {\n    const download = await env.ONEDRIVE.getDownloadUrl(file.id);\n    // Handle download.status, then let the user open download.url.\n  }\n}',
      },
    ],
  },
];

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const cli = (principal: Principal, configuration: Pick<Configuration, "PLATFORM_URL">) =>
  `widefleet --url ${shellQuote(configuration.PLATFORM_URL)} --organization ${shellQuote(principal.application.organizationId)}`;

export const templateCatalog = (
  principal: Principal,
  configuration: Pick<Configuration, "PLATFORM_URL">,
  search = "",
) => {
  const term = search.trim().toLowerCase();

  return appTemplateCatalog.parse({
    templates: templates.flatMap((template) =>
      `${template.name} ${template.description} ${template.capabilities.join(" ")}`
        .toLowerCase()
        .includes(term)
        ? [{ id: template.id, name: template.name, description: template.description }]
        : [],
    ),
    createPrompt: `Help me create an app on Widefleet. Ask what it should do and which services it needs. Read https://widefleet.com/SKILL.md and follow the app development guide. Use ${cli(principal, configuration)} for this installation and organization. Check existing apps and templates for reusable functionality, then build, test and deploy the app and help me complete its setup. Collect credentials through protected files or the app's Secrets page.`,
  });
};

export const readTemplate = (
  principal: Principal,
  configuration: Pick<Configuration, "PLATFORM_URL">,
  id: string,
) => {
  const template = templates.find((entry) => entry.id === id);

  if (!template)
    return Result.err(
      new InvalidOperation({ code: "NOT_FOUND", message: "App template not found" }),
    );
  const command = cli(principal, configuration);
  const source = `https://github.com/widefleet/widefleet/tree/main/apps/${template.id}`;
  const secrets = [...template.secrets, "AUTH_SECRET"];

  return Result.ok(
    appTemplate.parse({
      ...template,
      source,
      secrets,
      instructions: [
        `Use ${command} for all Widefleet commands below. Read https://widefleet.com/SKILL.md for CLI installation and authentication.`,
        `Inspect widefleet apps and widefleet services for an existing suitable app before creating one. Confirm the target app before updating an existing deployment.`,
        `Copy the complete apps/${template.id} directory from https://github.com/widefleet/widefleet into a local project. This is a ready-to-use ordinary app. Keep its source for later changes.`,
        `From the app directory, run pnpm install, pnpm typecheck and pnpm test. Choose the app name in wrangler.jsonc, then run widefleet deploy. The CLI builds the app and creates its declared database. Wait for the deployment to succeed and record its app URL.`,
        `The installation needs app sign-in and public HTTPS app URLs. An administrator must configure the provider's OAuth application and app secrets. ${template.setup}`,
        `Generate AUTH_SECRET as a cryptographically random value of at least 32 characters and keep it stable; it encrypts saved account tokens. Store credentials with widefleet secret put NAME --file /protected/file or through the app's Secrets page. Keep secret values out of chat and source code.`,
        `Allow these backend origins using widefleet network allow ORIGIN from the app directory: ${template.network.join(", ")}. This needs network:manage in addition to the usual CLI scopes. If a new login is needed, request platform:read, platform:write and network:manage. Wait for configuration activation.`,
        `Open the app URL to complete the personal account connection in the browser. Each user connects their own account.`,
        `To use the API from another app, an administrator grants an app connection with widefleet connect TARGET --as BINDING from that consuming app's directory. Replace the example target name if the deployed app has a different name. Calls must handle a signed-in user's request so the existing verified caller identity reaches the app.`,
        `Use the examples and the app's src/app.ts for its methods and inputs. Inspect each result's status: setup_required needs an administrator to configure missing secrets; connection_required, permission_required and reconnect_required include a connectUrl for the user. authentication_required means no signed-in user was delegated. Retry refresh_failed before asking the user to reconnect, and respect retryAfter for rate_limited.`,
        `Verify a read request through a connected app after account setup. Report the app URL and any remaining setup steps.`,
      ].join("\n\n"),
      prompt: `Set up the ${template.name} app on Widefleet. Read https://widefleet.com/SKILL.md, then run ${command} catalog templates show ${template.id} and follow its instructions and examples. Reuse a suitable existing app where possible. Help me finish setup and report its URL and any steps that still need my attention.`,
    }),
  );
};
