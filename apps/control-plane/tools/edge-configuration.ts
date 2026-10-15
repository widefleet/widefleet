import { z } from "zod";

const hostname = z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);

export const edgeInfrastructure = z
  .object({
    PLATFORM_URL: z.url().refine((value) => new URL(value).protocol === "https:"),
    APP_DOMAIN: hostname,
    TLS_MODE: z.enum(["provided", "cloudflare"]).default("provided"),
    ACME_EMAIL: z.email().optional(),
    ACME_ENVIRONMENT: z.enum(["staging", "production"]).default("production"),
  })
  .superRefine((configuration, context) => {
    if (configuration.TLS_MODE === "cloudflare" && configuration.ACME_EMAIL === undefined)
      context.addIssue({
        code: "custom",
        path: ["ACME_EMAIL"],
        message: "ACME_EMAIL is required for Cloudflare certificate issuance",
      });
  });

export const traefikConfiguration = (configuration: z.infer<typeof edgeInfrastructure>) => {
  const common = {
    entryPoints: {
      web: {
        address: ":8080",
        http: { redirections: { entryPoint: { to: ":443", scheme: "https" } } },
      },
      websecure: { address: ":8443" },
    },
    providers: { file: { directory: "/config/routes", watch: true } },
  };

  if (configuration.TLS_MODE === "provided") return common;

  return {
    ...common,
    certificatesResolvers: {
      letsencrypt: {
        acme: {
          email: configuration.ACME_EMAIL,
          storage: `/acme/${configuration.ACME_ENVIRONMENT}.json`,
          caServer:
            configuration.ACME_ENVIRONMENT === "staging"
              ? "https://acme-staging-v02.api.letsencrypt.org/directory"
              : "https://acme-v02.api.letsencrypt.org/directory",
          dnsChallenge: { provider: "cloudflare" },
        },
      },
    },
  };
};

export const edgeRoutes = (configuration: z.infer<typeof edgeInfrastructure>) => {
  const platform = new URL(configuration.PLATFORM_URL);

  if (platform.origin !== configuration.PLATFORM_URL) {
    throw new Error("PLATFORM_URL must be an HTTPS origin without a trailing slash");
  }

  if (
    platform.hostname === configuration.APP_DOMAIN ||
    platform.hostname.endsWith(`.${configuration.APP_DOMAIN}`)
  ) {
    throw new Error("The management hostname must be outside APP_DOMAIN to isolate login cookies");
  }

  const domainPattern = configuration.APP_DOMAIN.replaceAll(".", "\\.");

  return {
    tls: {
      certificates:
        configuration.TLS_MODE === "provided"
          ? [{ certFile: "/tls/fullchain.pem", keyFile: "/tls/privkey.pem" }]
          : [],
      options: { default: { minVersion: "VersionTLS12" } },
    },
    http: {
      routers: {
        management: {
          rule: `Host(\`${platform.hostname}\`)`,
          entryPoints: ["websecure"],
          service: "management",
          // Request one certificate for management and the entire app namespace.
          // Nested preview routers request an additional wildcard for their parent app.
          tls:
            configuration.TLS_MODE === "cloudflare"
              ? {
                  certResolver: "letsencrypt",
                  domains: [{ main: platform.hostname, sans: [`*.${configuration.APP_DOMAIN}`] }],
                }
              : {},
        },
        "app-sso": {
          rule: `Host(\`auth.${configuration.APP_DOMAIN}\`) || (HostRegexp(\`^[a-z0-9-]+\\.([a-z0-9-]+\\.)?${domainPattern}$\`) && PathPrefix(\`/oauth2/\`))`,
          priority: 10000,
          entryPoints: ["websecure"],
          service: "app-sso",
          tls: {},
        },
      },
      services: {
        management: { loadBalancer: { servers: [{ url: "http://control-plane:3000" }] } },
        "app-sso": { loadBalancer: { servers: [{ url: "http://auth-proxy:4180" }] } },
      },
    },
  };
};
