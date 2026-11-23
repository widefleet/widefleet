// How the template generator offers each method of the Gmail API. Review this
// file when the generator reports a new or removed method.
//
// Every method that is not a GET is listed with the kind of change it makes,
// which decides when it asks the user first (see src/approval.ts), or with the
// reason it is not offered. Sending email to others is `send`. GET methods are
// offered unless listed.

/** Where the generator reads the API, and the names of the generated code. */
export const generator = {
  kind: "discovery",
  source: "https://gmail.googleapis.com/$discovery/rest?version=v1",
  service: {
    name: "Gmail",
    className: "GmailApi",
    result: "GmailResult",
    properties: "GmailProperties",
  },
} as const;

/** Why a method is not offered. */
export const reasons = {
  serviceAccount:
    "Only available to service accounts with domain-wide delegation, not to a user's own account",
} as const;

type Hidden = { hidden: keyof typeof reasons };

export type Change = "create" | "update" | "delete" | "send";

export const operations = {
  "gmail.users.drafts.create": "create",
  "gmail.users.drafts.delete": "delete",
  "gmail.users.drafts.send": "send",
  "gmail.users.drafts.update": "update",
  "gmail.users.labels.create": "create",
  "gmail.users.labels.delete": "delete",
  "gmail.users.labels.patch": "update",
  "gmail.users.labels.update": "update",
  "gmail.users.messages.batchDelete": "delete",
  "gmail.users.messages.batchModify": "update",
  "gmail.users.messages.delete": "delete",
  "gmail.users.messages.import": "create",
  "gmail.users.messages.insert": "create",
  "gmail.users.messages.modify": "update",
  "gmail.users.messages.send": "send",
  "gmail.users.messages.trash": "delete",
  "gmail.users.messages.untrash": "update",
  "gmail.users.settings.cse.identities.create": "create",
  "gmail.users.settings.cse.identities.delete": "delete",
  "gmail.users.settings.cse.identities.patch": "update",
  "gmail.users.settings.cse.keypairs.create": "create",
  "gmail.users.settings.cse.keypairs.disable": "update",
  "gmail.users.settings.cse.keypairs.enable": "update",
  "gmail.users.settings.cse.keypairs.obliterate": "delete",
  "gmail.users.settings.delegates.create": { hidden: "serviceAccount" },
  "gmail.users.settings.delegates.delete": { hidden: "serviceAccount" },
  "gmail.users.settings.delegates.get": { hidden: "serviceAccount" },
  "gmail.users.settings.delegates.list": { hidden: "serviceAccount" },
  // A filter can forward future mail to another address.
  "gmail.users.settings.filters.create": "send",
  "gmail.users.settings.filters.delete": "delete",
  "gmail.users.settings.forwardingAddresses.create": { hidden: "serviceAccount" },
  "gmail.users.settings.forwardingAddresses.delete": { hidden: "serviceAccount" },
  "gmail.users.settings.sendAs.create": { hidden: "serviceAccount" },
  "gmail.users.settings.sendAs.delete": { hidden: "serviceAccount" },
  "gmail.users.settings.sendAs.patch": "update",
  "gmail.users.settings.sendAs.smimeInfo.delete": "delete",
  "gmail.users.settings.sendAs.smimeInfo.insert": "create",
  "gmail.users.settings.sendAs.smimeInfo.setDefault": "update",
  "gmail.users.settings.sendAs.update": "update",
  "gmail.users.settings.sendAs.verify": { hidden: "serviceAccount" },
  "gmail.users.settings.updateAutoForwarding": { hidden: "serviceAccount" },
  "gmail.users.settings.updateImap": "update",
  "gmail.users.settings.updateLanguage": "update",
  "gmail.users.settings.updatePop": "update",
  "gmail.users.settings.updateVacation": "update",
  "gmail.users.stop": "update",
  "gmail.users.threads.delete": "delete",
  "gmail.users.threads.modify": "update",
  "gmail.users.threads.trash": "delete",
  "gmail.users.threads.untrash": "update",
  "gmail.users.watch": "update",
} satisfies Record<string, Change | Hidden>;
