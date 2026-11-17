export const executionProfiles = {
  http: { cpuMs: 100, subRequests: 50 },
  service: { cpuMs: 250, subRequests: 50 },
  cron: { cpuMs: 1000, subRequests: 200 },
  workflow: { cpuMs: 5000, subRequests: 500 },
  readiness: { cpuMs: 100, subRequests: 10 },
};

// Observe the actual production call sites while forwarding to the native
// loader. Local workerd does not provide production CPU enforcement.
export const executionRecorder = `
const executions = [];
function recordExecution(env) {
  const loader = env.WIDEFLEET_LOADER;
  const observe = (worker, key) => ({
    getEntrypoint(name, options) {
      executions.push({ key, entrypoint: name ?? null, limits: options?.limits ?? null });
      return worker.getEntrypoint(name, options);
    },
    getDurableObjectClass(name, options) {
      executions.push({ key, facet: name, limits: options?.limits ?? null });
      return worker.getDurableObjectClass(name, options);
    },
    dispose() { worker.dispose?.(); },
  });
  return {
    ...env,
    WIDEFLEET_LOADER: {
      get(key, callback) { return observe(loader.get(key, callback), key); },
      load(code) { return observe(loader.load(code), null); },
    },
  };
}
`;
