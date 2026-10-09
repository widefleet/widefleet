import { followRedirects } from "./network.ts";

// celld's brokered global fetch returns one response and loses redirect modes.
// Follow in the child so every hop crosses the policy gateway.
export const installFetch = () => {
  const send = globalThis.fetch;
  globalThis.fetch = (input, init) => followRedirects(new Request(input, init), send);
};
