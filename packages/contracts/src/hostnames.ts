export const workerHostname = (name: string, organizationSuffix: string | null, domain: string) =>
  `${name}${organizationSuffix === null ? "" : `-${organizationSuffix}`}.${domain}`;

export const connectorBrowserOrigin = (
  name: string,
  organizationSuffix: string | null,
  domain: string,
  port = 443,
) => `https://${workerHostname(name, organizationSuffix, domain)}${port === 443 ? "" : `:${port}`}`;
