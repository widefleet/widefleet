// Provider responses and proxy logs can contain credentials, URLs and arbitrary text.
// Only fixed messages may cross the activation-status boundary into API/CLI/UI output.
export const ssoFailureReason = (output: string, phase: "validation" | "startup") => {
  if (
    /certificate signed by unknown authority|unable to get local issuer certificate/i.test(output)
  )
    return "The identity provider's TLS certificate is not trusted. Check the SSO container's CA certificates and the provider's certificate chain.";

  if (/x509:|tls: failed to verify certificate/i.test(output))
    return "The identity provider's TLS certificate could not be verified. Check its hostname, validity dates and certificate chain, and the system clock.";

  if (/no such host|temporary failure in name resolution/i.test(output))
    return "The identity provider's hostname could not be resolved. Check the issuer URL and the SSO container's DNS configuration.";

  if (/connection refused|network is unreachable|no route to host/i.test(output))
    return "The identity provider could not be reached. Check the issuer URL, network access and firewall rules from the SSO container.";

  if (/context deadline exceeded|i\/o timeout|TLS handshake timeout|Client\.Timeout/i.test(output))
    return "The identity provider did not respond in time. Check its availability and network access from the SSO container.";

  if (/oidc: issuer did not match/i.test(output))
    return "The discovery document's issuer does not match the configured issuer URL. Use the exact issuer advertised by the identity provider.";

  if (/cookie_secret must be/i.test(output))
    return "The SSO cookie secret is invalid. Configure a secret that decodes to 16, 24 or 32 bytes.";

  return phase === "validation"
    ? "The sign-in configuration is invalid. Check the provider settings and the SSO container configuration, then save again."
    : "The sign-in service could not start. Check the provider settings and the SSO container logs, then save again.";
};
