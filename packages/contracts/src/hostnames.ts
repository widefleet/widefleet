export const workerHostname = (name: string, organizationSuffix: string | null, domain: string) =>
  `${name}${organizationSuffix === null ? "" : `-${organizationSuffix}`}.${domain}`;
