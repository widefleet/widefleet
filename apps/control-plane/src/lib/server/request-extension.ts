// Optional installation middleware runs before creating an application runtime.
export const handleExtensionRequest = (_request: Request): Promise<Response | undefined> =>
  Promise.resolve(undefined);
