// Workspace pages live below their organization's slug, for example `/acme/apps`.
export const workspacePath = (organization: string, path = "/") =>
  path === "/" ? `/${organization}` : `/${organization}${path}`;

// Destinations chosen before the organization is known name it with this placeholder, for
// example `/[organization]/welcome`. The organization chooser fills it in.
export const organizationPlaceholder = "[organization]";

export const chosenDestination = (destination: string, organization: string) =>
  destination === "/"
    ? workspacePath(organization)
    : destination.replaceAll(organizationPlaceholder, organization);
