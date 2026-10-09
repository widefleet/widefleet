export default {
  dialect: "postgresql",
  schema: ["./src/lib/server/schema.ts", "./src/lib/server/auth-schema.ts"],
  out: "./migrations",
};
