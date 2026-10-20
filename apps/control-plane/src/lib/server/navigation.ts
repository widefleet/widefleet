export const localDestination = (value: string | null | undefined) => {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  const base = "https://navigation.invalid";
  const url = URL.parse(value, base);

  // Normalize before returning: control characters and dot segments can turn an
  // apparently local path into an external or protocol-relative destination.
  if (!url || url.origin !== base || url.pathname.startsWith("//")) return "/";

  return url.pathname + url.search + url.hash;
};
