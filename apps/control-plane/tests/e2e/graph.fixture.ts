// Microsoft Graph for the emulated Entra tenant: every member belongs to one
// synthetic group. Other requests use the network as usual.
export const graphGroup = "00000000-0000-4000-8000-0000000000a1";

const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));

  if (url.href === "https://graph.microsoft.com/v1.0/me/transitiveMemberOf")
    return Response.json({ value: [{ id: graphGroup }] });

  return originalFetch(input, init);
};
