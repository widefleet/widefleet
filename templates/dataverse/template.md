---
name: Dataverse
description: Read and change the tables of a Microsoft Dataverse environment and call its actions and functions, with your own security roles and typed results.
---

Work with the data of Power Apps and Dynamics 365 from your agents and apps: query
and change rows of any table, create tables, columns and security roles, and call
Dataverse's actions and functions. Each person connects their own work account;
each call names the environment it works in. Dataverse applies the person's
security roles there.

## Set up

1. Register a Microsoft Entra application for **Accounts in any organizational
   directory**.
2. Add `https://YOUR-APP-URL/auth/callback/microsoft` as a **Web** redirect URI and
   add the delegated **Dynamics CRM** permission `user_impersonation`.
3. Create a client secret and save the application's client ID and the secret's
   **value** as `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` on the app's
   **Secrets** page.
4. Open the app and connect your account. The page lists your environments; allow
   the app to reach each one it should use:

   ```sh
   widefleet network allow https://YOUR-ENVIRONMENT.api.crm.dynamics.com
   ```

## Use it

Ask your agent, for example "List the open accounts in Dataverse". To call it from
your own app, connect it from the app's directory:

```sh
widefleet connect dataverse --as DATAVERSE
```

Every method takes the environment's host as `environment`; `listEnvironments` lists
them. Rows of every table are read and changed with `listRows`, `getRow`,
`createRow`, `updateRow` and `deleteRow`, single columns and files with `getColumn`,
`setColumn` and `uploadColumnContent`, and the rows they relate to, such as a table's
columns, with `listRelatedRows`, `createRelatedRow` and `replaceRelatedRow`. `batch`
runs many requests at once, change sets as one transaction. Each action and function
of the Web API is a method, such as `whoAmI`, `addPrivilegesRole` and `publishXml`;
`callAction` and `callFunction` call those a solution adds. Methods take the Web API's
query options and headers, such as `$filter`, `prefer` or `solutionUniqueName`. See [using a template
app](https://widefleet.com/docs/guides/app-templates#use-from-agents-and-apps) for
calls, approvals and results.
