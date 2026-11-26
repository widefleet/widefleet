---
name: GitHub
description: Read and change repositories, issues, pull requests and projects through GitHub's GraphQL API, with typed results.
---

Work with GitHub repositories, issues, pull requests, reviews, discussions and
projects from your agents and apps. Each person connects their own GitHub account.

## Set up

Install the template, open the app and connect your GitHub account. A GitHub
organization that restricts OAuth apps has an owner approve the app once, and an
organization with SAML single sign-on asks each person to authorize it.

If the app asks for `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, your installation
uses your own GitHub OAuth app: register one with the authorization callback URL
`https://YOUR-APP-URL/auth/callback/github` and save its credentials on the app's
**Secrets** page.

## Use it

Ask your agent, for example "List pull requests waiting for my review". To call it
from your own app, connect it from the app's directory:

```sh
widefleet connect github --as GITHUB
```

Every query and mutation of GitHub's GraphQL API is a method with the same name,
such as `repository`, `search` and `addComment`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
