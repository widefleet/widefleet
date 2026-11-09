import { accountAppTests } from "@platform/account-connection/testing";

accountAppTests(new URL("./app.ts", import.meta.url), "github");
