import MarkdownIt from "markdown-it";
import { createAppPrompt, templateCatalog, readTemplate } from "#server/app-templates";
import { form, getRequestEvent, query } from "$app/server";
import { invalid, redirect } from "@sveltejs/kit";
import {
  appAbout,
  appDescription,
  appDisplayName,
  appPath,
  networkPolicy,
  organizationSelection,
  templateInstallInput,
  templatePath,
  templateSearch,
} from "@platform/contracts";
import { z } from "zod";
import { getAppDetails, getApps } from "#lib/apps.remote";
import { InvalidOperation } from "#server/errors";
import { templateNetworkChanged } from "#server/template-installs";
import { formValue, queryValue, remoteContext } from "#server/remote-support";
import { workspacePath } from "#lib/workspace-path";

export const getCatalog = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return queryValue(await runtime.apps.catalog(principal));
});

// A person's own text, so it renders without raw HTML or images from other sites.
const markdown = new MarkdownIt({ html: false }).disable("image");

export const getAppListing = query(
  appPath.extend(organizationSelection.shape),
  async ({ appId, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    const listing = queryValue(await runtime.apps.listing(principal, appId));

    return { ...listing, aboutHtml: listing.about ? markdown.render(listing.about) : "" };
  },
);

export const setCatalogListing = form(
  appPath.extend({
    ...organizationSelection.shape,
    listed: z.enum(["true", "false"]),
    search: z.string().trim().max(200).default(""),
  }),
  async ({ appId, listed, search, organizationId }) => {
    const { runtime, principal, organization } = await remoteContext({ organizationId });
    formValue(await runtime.apps.setCatalogListing(principal, appId, listed === "true"));
    await getAppDetails({ appId, search, organizationId }).refresh();
    await getCatalog({ organizationId }).refresh();

    if (!getRequestEvent().isRemoteRequest)
      redirect(
        303,
        workspacePath(
          organization.slug,
          `/apps/${appId}/access?${new URLSearchParams({ q: search })}#home`,
        ),
      );

    return { saved: true };
  },
);

// One text of an app that people edit in place. The forms share this shape, so one editor
// serves them.
const appText = (value: z.ZodType<string, string>) =>
  appPath.extend({
    ...organizationSelection.shape,
    value,
    search: z.string().trim().max(200).default(""),
  });

// The description appears with the app in the catalog, so both views reload.
export const setAppDescription = form(
  appText(appDescription),
  async ({ appId, value, search, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.apps.setDescription(principal, appId, value));
    await getAppDetails({ appId, search, organizationId }).refresh();
    await getCatalog({ organizationId }).refresh();

    return { saved: true };
  },
);

// A browser sends a field's line breaks as two characters, which would count against the limit.
export const setAppAbout = form(
  appText(
    z
      .string()
      .transform((text) => text.replaceAll("\r\n", "\n"))
      .pipe(appAbout),
  ),
  async ({ appId, value, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.apps.setAbout(principal, appId, value));
    await getAppListing({ appId, organizationId }).refresh();

    return { saved: true };
  },
);

// The name also appears in the list of apps a person manages.
export const renameApp = form(
  appText(appDisplayName),
  async ({ appId, value, search, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });
    formValue(await runtime.apps.rename(principal, appId, value));
    await getAppDetails({ appId, search, organizationId }).refresh();
    await getApps({ organizationId }).refresh();
    await getCatalog({ organizationId }).refresh();

    return { saved: true };
  },
);

// The prompt needs no template, so it stays available while GitHub cannot be reached.
export const getCreatePrompt = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return createAppPrompt(principal, runtime.configuration);
});

export const getTemplates = query(
  templateSearch.extend(organizationSelection.shape),
  async ({ search, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    const installed = queryValue(await runtime.apps.templateInstalls(principal));

    return queryValue(await templateCatalog(principal, runtime.configuration, installed, search));
  },
);

export const installTemplate = form(
  templateInstallInput.omit({ secrets: true }).extend({
    ...organizationSelection.shape,
    // The leading underscore keeps the values out of a returned failed form.
    _secrets: templateInstallInput.shape.secrets,
    // The origins the page showed next to the install button, as JSON.
    network: z.string().transform((value, context) => {
      let parsed;

      try {
        parsed = networkPolicy.safeParse(JSON.parse(value));
      } catch {
        parsed = networkPolicy.safeParse(null);
      }

      if (parsed.success) return parsed.data;
      context.addIssue({ code: "custom", message: "Reload the template and install again." });

      return z.NEVER;
    }),
  }),
  async ({ organizationId, templateId, name, network, _secrets }, issue) => {
    const { runtime, principal, organization } = await remoteContext({ organizationId });

    const installed = await runtime.templates.install(
      principal,
      { templateId, name, secrets: _secrets },
      { consentedNetwork: network },
    );

    if (installed.isErr() && installed.error.message === templateNetworkChanged) {
      await getTemplate({ templateId, organizationId }).refresh();
      invalid(templateNetworkChanged);
    }

    // A taken name is an issue of the name field, which the page then shows.
    if (
      installed.isErr() &&
      installed.error instanceof InvalidOperation &&
      installed.error.code === "CONFLICT"
    )
      invalid(issue.name(installed.error.message));

    const result = formValue(installed);

    // The deployment page shows the build's progress through activation.
    redirect(303, workspacePath(organization.slug, `/apps/${result.app.id}/deployments`));
  },
);

// Keep entered credentials in the form while the installer opens provider settings.
const fieldMarkdown = new MarkdownIt({ html: false }).disable("image");

fieldMarkdown.renderer.rules["link_open"] = (tokens, index, options, _env, renderer) => {
  tokens[index]?.attrSet("target", "_blank");
  tokens[index]?.attrSet("rel", "noopener noreferrer");

  return renderer.renderToken(tokens, index, options);
};

export const getTemplate = query(
  templatePath.extend(organizationSelection.shape),
  async ({ templateId, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    const installed = queryValue(await runtime.apps.templateInstalls(principal));

    const template = queryValue(
      await readTemplate(
        principal,
        runtime.configuration,
        templateId,
        runtime.templates.available,
        installed,
        queryValue(await runtime.apps.newAppHostname(principal, templateId)),
      ),
    );

    const descriptions = new Map(Object.entries(template.secretHelp ?? {}));

    const secretFields = template.requiredSecrets.map((name) => ({
      name,
      helpHtml: fieldMarkdown.render(descriptions.get(name) ?? ""),
    }));

    return {
      ...template,
      secretFields,
      html: new MarkdownIt({ html: false }).render(template.markdown),
    };
  },
);
