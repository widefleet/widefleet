import { json } from "@sveltejs/kit";
import { protocolVersion } from "@platform/contracts";

export const GET = () => json({ status: "ok", protocolVersion });
