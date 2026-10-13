import { controlPlaneConfig } from "./vite.config.ts";

// SvelteKit's post-build analysis reloads the config without the original Vite mode.
export default controlPlaneConfig("cloudflare");
