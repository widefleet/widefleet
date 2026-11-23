import MarkdownIt from "markdown-it";
import { templateCatalog, readTemplate } from "#server/app-templates";
import { form, getRequestEvent, query } from "$app/server";
import { invalid, redirect } from "@sveltejs/kit";
import {
  appDescriptionChange,
  appPath,
  networkPolicy,
  organizationSelection,
  templateInstallInput,
  templatePath,
  templateSearch,
} from "@platform/contracts";
import { z } from "zod";
import { getAppDetails } from "#lib/apps.remote";
import { InvalidOperation } from "#server/errors";
import { templateNetworkChanged } from "#server/template-installs";
import { formValue, queryValue, remoteContext } from "#server/remote-support";
import { workspacePath } from "#lib/workspace-path";

export const getCatalog = query(organizationSelection, async (selection) => {
  const { runtime, principal } = await remoteContext(selection);

  return queryValue(await runtime.apps.catalog(principal));
});

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
          `/apps/${appId}/settings?${new URLSearchParams({ q: search })}#catalog`,
        ),
      );

    return { saved: true };
  },
);

// The description appears with the app in the catalog, so both views reload.
export const setAppDescription = form(
  appPath.extend({
    ...organizationSelection.shape,
    ...appDescriptionChange.shape,
    search: z.string().trim().max(200).default(""),
  }),
  async ({ appId, description, search, organizationId }) => {
    const { runtime, principal, organization } = await remoteContext({ organizationId });
    formValue(await runtime.apps.setDescription(principal, appId, description));
    await getAppDetails({ appId, search, organizationId }).refresh();
    await getCatalog({ organizationId }).refresh();

    if (!getRequestEvent().isRemoteRequest)
      redirect(
        303,
        workspacePath(
          organization.slug,
          `/apps/${appId}/settings?${new URLSearchParams({ q: search })}#description`,
        ),
      );

    return { saved: true };
  },
);

export const getTemplates = query(
  templateSearch.extend(organizationSelection.shape),
  async ({ search, organizationId }) => {
    const { runtime, principal } = await remoteContext({ organizationId });

    const installed = queryValue(await runtime.apps.templateInstalls(principal));

    return queryValue(await templateCatalog(principal, runtime.configuration, installed, search));
  },
);

export const installTemplate = form(
  templateInstallInput.extend(organizationSelection.shape).extend({
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
  async ({ organizationId, templateId, name, network }, issue) => {
    const { runtime, principal, organization } = await remoteContext({ organizationId });

    const installed = await runtime.templates.install(
      principal,
      { templateId, name },
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
      ),
    );

    return { ...template, html: new MarkdownIt({ html: false }).render(template.markdown) };
  },
);
