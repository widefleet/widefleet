// Workspace pages live below their organization's slug, for example `/acme/apps`.
export const workspacePath = (organization: string, path = "/") =>
  path === "/" ? `/${organization}` : `/${organization}${path}`;
