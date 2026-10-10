import { defineConfig } from "blume";
import { posthog, script } from "blume/analytics";
import { native } from "blume/consent";
import { existsSync, readFileSync } from "node:fs";
import { rename } from "node:fs/promises";

const websiteUrl = (process.env["DOCS_WEBSITE_URL"]?.trim() || "https://widefleet.com").replace(
  /\/+$/,
  "",
);

const repositoryUrl = "https://github.com/widefleet/widefleet";

const privacyUrl = new URL("/privacy", websiteUrl).href;

const imprintUrl = new URL("/imprint", websiteUrl).href;

const config = defineConfig({
  title: "Widefleet Docs",
  description:
    "Open-source platform for agent-built apps and workflows. Let agents deploy apps and workflows with company login, databases, file storage, and controlled access to your systems.",
  logo: {
    image: "/brand/widefleet-mark-q2.svg",
    text: "widefleet",
    href: websiteUrl,
  },
  theme: {
    mode: "system",
    accent: { light: "#22221f", dark: "#deded8" },
    background: { light: "#fafaf7", dark: "#1d1d1b" },
    radius: "sm",
  },
  navigation: {
    cta: { label: "GitHub", href: repositoryUrl },
    repo: repositoryUrl,
    sidebar: { display: "group" },
  },
  feedback: false,
  // Crawler policy is managed at the public origin's /robots.txt.
  seo: { robots: false },
  footer: {
    links: [
      { label: "Privacy policy", href: privacyUrl },
      { label: "Imprint", href: imprintUrl },
    ],
  },
  deployment: { site: "https://widefleet.com", base: "/docs" },
  integrations: [
    {
      name: "widefleet-docs-dev-assets",
      hooks: {
        "astro:config:setup": ({ command, config: astroConfig, updateConfig }) => {
          if (command === "dev") {
            // Let Vite handle the dev prefix once for pages, modules and hot reload.
            // Keep the public base available to components through BASE_URL.
            updateConfig({
              base: "/",
              build: {
                assets: `${astroConfig.base.replace(/^\/|\/$/g, "")}/${astroConfig.build.assets}`,
              },
              vite: {
                base: astroConfig.base,
                define: { "import.meta.env.BASE_URL": JSON.stringify(astroConfig.base) },
              },
            });
          }
        },
        "astro:server:setup": ({ server }) => {
          const base = server.config.base.replace(/\/$/, "");
          server.middlewares.use((request, _response, next) => {
            // Vite's base stripping needs a slash before a root query string.
            if (request.url?.startsWith(`${base}?`)) {
              request.url = `${base}/${request.url.slice(base.length)}`;
            }

            next();
          });
        },
      },
    },
    {
      name: "widefleet-skill-filename",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          const generatedSkill = new URL("skill.md", dir);

          // Blume emits this after rendering; isolated builds omit agent artifacts.
          if (existsSync(generatedSkill)) {
            await rename(generatedSkill, new URL("SKILL.md", dir));
          }
        },
      },
    },
  ],
});

const posthogKey = (
  process.env["DOCS_POSTHOG_KEY"] ?? "phc_AdQ4DSNi7QHqvTVqhTGNFUNa5YxkiwLddL46KFSPvkML"
).trim();

if (posthogKey) {
  config.analytics = [
    // Resolve the shared preference before PostHog reads Blume's consent state.
    script({
      content: readFileSync(new URL("./public/consent.js", import.meta.url), "utf8"),
      attributes: { "data-blume-consent": "essential" },
    }),
    posthog({
      key: posthogKey,
      host: process.env["DOCS_POSTHOG_HOST"]?.trim() || "https://eu.i.posthog.com",
      persistence: "cookie",
      opt_out_capturing_persistence_type: "cookie",
      cookie_expiration: 180,
      cross_subdomain_cookie: false,
      opt_out_capturing_by_default: false,
      opt_out_persistence_by_default: true,
      capture_pageview: "history_change",
      person_profiles: "never",
      autocapture: true,
      disable_session_recording: true,
    }),
    // Runs only after consent, following the SDK loader. Clears an earlier opt-out.
    script({
      content: "window.posthog?.opt_in_capturing({ captureEventName: false });",
    }),
  ];
  config.consent = native({ policy: privacyUrl });
  config.i18n = {
    locales: [{ code: "en", label: "English" }],
    ui: {
      en: {
        consent: {
          message:
            "Help us improve our website and docs. Allow PostHog analytics cookies to measure visits and interactions? Withdraw anytime in Cookie settings.",
          accept: "Allow",
          decline: "Decline",
        },
      },
    },
  };
  config.search = { analytics: { queries: true } };
}

export default config;
