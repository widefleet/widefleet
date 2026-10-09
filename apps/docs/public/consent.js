// Shared browser contract: widefleet-consent = granted | denied, valid for 180 days.
// Keep this file self-contained so each website can serve it independently.
(() => {
  /** @typedef {"granted" | "denied"} Choice */
  /** @typedef {{ get: () => Choice | null, set: (choice: Choice) => void, sync: () => void, open: () => void }} Consent */
  /** @typedef {{ set: (state: { analytics: boolean }) => void, open?: () => void }} BlumeConsent */
  /** @typedef {{ opt_out_capturing: () => void, config?: { token?: string } }} Analytics */
  // SAFETY: These optional browser extensions are checked before use; this script creates Consent.
  const browser =
    /** @type {Window & { widefleetConsent?: Consent, blumeConsent?: BlumeConsent, posthog?: Analytics }} */ (
      window
    );

  if (browser.widefleetConsent) return;

  const cookieName = "widefleet-consent";
  const blumeStorageKey = "blume-consent";

  /** @param {unknown} value */
  const valid = (value) => value === "granted" || value === "denied";

  /** @param {string} key @param {string | null} value */
  const remember = (key, value) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* The current page still works when storage is blocked. */
    }
  };

  const readCookie = () => {
    try {
      const value = document.cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);

      return valid(value) ? value : null;
    } catch {
      return null;
    }
  };

  /** @param {Choice} value */
  const writeCookie = (value) => {
    try {
      document.cookie =
        `${cookieName}=${value}; Path=/; Max-Age=15552000; SameSite=Lax` +
        (location.protocol === "https:" ? "; Secure" : "");
    } catch {
      /* A blocked cookie limits the choice to this page. */
    }
  };

  let choice = readCookie();

  // The preference cookie is required; local storage alone never authorizes analytics.

  /** @param {Choice | null} next */
  const apply = (next) => {
    choice = next;
    remember(blumeStorageKey, next);

    // Stop the SDK before Blume reloads on withdrawal.
    if (next !== "granted") {
      browser.posthog?.opt_out_capturing();
      const token = browser.posthog?.config?.token;

      // These tab identifiers are not cleared by the SDK's persistence opt-out.
      if (token) {
        try {
          sessionStorage.removeItem(`ph_${token}_window_id`);
          sessionStorage.removeItem(`ph_${token}_primary_window_exists`);
        } catch {
          /* Storage can be unavailable; opt-out still takes effect. */
        }
      }
    }

    window.dispatchEvent(new CustomEvent("widefleet:consent", { detail: { choice: next } }));
    browser.blumeConsent?.set({ analytics: next === "granted" });
    const banner = document.querySelector("[data-blume-consent-banner]");

    if (banner instanceof HTMLElement) banner.hidden = next !== null;
  };

  /** @param {Choice} next */
  const set = (next) => {
    if (!valid(next)) return;
    writeCookie(next);
    apply(next);
  };

  const sync = () => {
    const next = readCookie();

    if (next !== choice) apply(next);
  };

  browser.widefleetConsent = {
    get: () => choice,
    set,
    sync,
    open: () => {
      if (browser.blumeConsent?.open) browser.blumeConsent.open();
      else window.dispatchEvent(new Event("widefleet:consent-open"));
    },
  };
  apply(choice);

  // Save before Blume's own click handler and PostHog's interaction handlers run.
  document.addEventListener(
    "click",
    (event) => {
      const button =
        event.target instanceof Element
          ? event.target.closest("[data-blume-consent-choice]")
          : null;

      if (button instanceof HTMLElement)
        set(button.dataset.blumeConsentChoice === "accept" ? "granted" : "denied");
    },
    true,
  );
  window.addEventListener("focus", sync);
  window.addEventListener("pageshow", sync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync();
  });
  document.addEventListener("astro:before-swap", sync);
})();
