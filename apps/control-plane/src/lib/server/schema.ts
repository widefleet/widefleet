import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.ts";

export const fleets = pgTable("fleet", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
  runtime: jsonb(),
  appliedRuntime: jsonb("applied_runtime"),
  runtimeJobId: uuid("runtime_job_id"),
});

export const runtimeReleases = pgTable("runtime_release", {
  version: text().primaryKey(),
  checksum: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connectors = pgTable(
  "connector",
  {
    fleetId: uuid("fleet_id")
      .notNull()
      .references(() => fleets.id),
    name: text().notNull(),
    package: jsonb().notNull(),
    appliedPackage: jsonb("applied_package"),
    jobId: uuid("job_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.fleetId, table.name] })],
);

export const agents = pgTable("agent", {
  id: uuid().primaryKey(),
  fleetId: uuid("fleet_id")
    .notNull()
    .references(() => fleets.id),
  name: text().notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  enabled: boolean().notNull().default(true),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apps = pgTable(
  "app",
  {
    id: uuid().primaryKey(),
    slug: text().notNull().unique(),
    displayName: text("display_name").notNull(),
    catalogListed: boolean("catalog_listed").notNull().default(false),
    parentId: uuid("parent_id"),
    fleetId: uuid("fleet_id")
      .notNull()
      .references(() => fleets.id),
    hostname: text().notNull().unique(),
    state: text({ enum: ["created", "active", "deleting"] })
      .notNull()
      .default("created"),
    activeDeploymentId: uuid("active_deployment_id"),
    accessGroups: jsonb("access_groups").notNull().default([]),
    accessUsers: jsonb("access_users").notNull().default([]),
    accessProvider: text("access_provider").notNull().default(""),
    allAuthenticated: boolean("all_authenticated").notNull().default(false),
    accessRevision: integer("access_revision").notNull().default(0),
    appliedAccessRevision: integer("applied_access_revision"),
    accessError: text("access_error"),
    networkPolicy: jsonb("network_policy").notNull().default({ backend: [], browser: [] }),
    networkRevision: integer("network_revision").notNull().default(0),
    appliedNetworkRevision: integer("applied_network_revision"),
    networkError: text("network_error"),
    capabilities: jsonb().notNull().default({}),
    capabilityRevision: integer("capability_revision").notNull().default(0),
    appliedCapabilityRevision: integer("applied_capability_revision"),
    capabilityError: text("capability_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("app_parent_idx").on(table.parentId)],
);

export const appRoleAssignments = pgTable(
  "app_role_assignment",
  {
    id: uuid().primaryKey(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    type: text({ enum: ["user", "group"] }).notNull(),
    provider: text().notNull(),
    subject: text().notNull(),
    role: text({ enum: ["user", "developer", "admin"] }).notNull(),
  },
  (table) => [
    uniqueIndex("app_role_assignment_unique").on(
      table.appId,
      table.type,
      table.provider,
      table.subject,
      table.role,
    ),
    index("app_role_assignment_principal").on(table.provider, table.type, table.subject),
  ],
);

export const uploadSessions = pgTable(
  "upload_session",
  {
    id: uuid().primaryKey(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    manifest: jsonb().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("upload_session_app_idx").on(table.appId)],
);

export const artifacts = pgTable("artifact", {
  id: uuid().primaryKey(),
  appId: uuid("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  metadata: jsonb().notNull(),
  manifest: jsonb().notNull(),
  modules: jsonb().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deployments = pgTable(
  "deployment",
  {
    id: uuid().primaryKey(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    status: text({ enum: ["queued", "running", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    message: text(),
    requestId: text("request_id").notNull(),
  },
  (table) => [uniqueIndex("deployment_request_idx").on(table.appId, table.requestId)],
);

export const jobs = pgTable(
  "job",
  {
    id: uuid().primaryKey(),
    sequence: bigint({ mode: "number" }).generatedAlwaysAsIdentity().unique(),
    appId: uuid("app_id").references(() => apps.id, { onDelete: "cascade" }),
    fleetId: uuid("fleet_id")
      .notNull()
      .references(() => fleets.id),
    agentId: uuid("agent_id").references(() => agents.id),
    deploymentId: uuid("deployment_id").references(() => deployments.id),
    kind: text({
      enum: ["deploy", "runtime", "connector", "delete", "configure", "migrations", "workflows"],
    }).notNull(),
    migration: jsonb(),
    workflow: jsonb(),
    rollback: boolean().notNull().default(false),
    access: jsonb(),
    network: jsonb(),
    capabilities: jsonb(),
    connector: jsonb(),
    connectors: jsonb().notNull().default([]),
    runtime: jsonb(),
    state: text({ enum: ["queued", "running", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    attempt: integer().notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    result: jsonb(),
  },
  (table) => [index("job_fleet_state_idx").on(table.fleetId, table.state, table.sequence)],
);

export const deploymentEvents = pgTable("deployment_event", {
  id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  deploymentId: uuid("deployment_id")
    .notNull()
    .references(() => deployments.id, { onDelete: "cascade" }),
  level: text({ enum: ["info", "error"] }).notNull(),
  message: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobReceipts = pgTable("job_receipt", {
  jobId: uuid("job_id").primaryKey(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  leaseToken: uuid("lease_token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const installation = pgTable("installation", {
  id: text().primaryKey(),
  reportingId: uuid("reporting_id").notNull().defaultRandom(),
  reportingRevision: integer("reporting_revision").notNull().default(0),
  usageReporting: boolean("usage_reporting").notNull().default(true),
  crashReporting: boolean("crash_reporting").notNull().default(true),
  settings: jsonb().notNull(),
  ownerId: text("owner_id").references(() => user.id),
  localPasswordEnabled: boolean("local_password_enabled").notNull().default(true),
});

export const installationSecrets = pgTable("installation_secret", {
  id: text().primaryKey(),
  ciphertext: text().notNull(),
});
