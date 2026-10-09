import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  process.env["CONSENT_SCRIPT_FIXTURE"] ?? new URL("../public/consent.js", import.meta.url),
  "utf8",
);

interface Consent {
  get: () => "granted" | "denied" | null;
  set: (choice: "granted" | "denied") => void;
}

class FakeElement {
  hidden = true;
}

class FakeWindow extends EventTarget {
  widefleetConsent?: Consent;

  blumeConsent = {
    analytics: false,
    set: ({ analytics }: { analytics: boolean }) => {
      this.blumeConsent.analytics = analytics;
    },
  };
}

interface BrowserOptions {
  jar?: Map<string, string>;
  storage?: Map<string, string>;
  hostname?: string;
  blocked?: boolean;
}

function browser({
  jar = new Map<string, string>(),
  storage = new Map<string, string>(),
  hostname = "widefleet.com",
  blocked = false,
}: BrowserOptions = {}) {
  const writes: string[] = [];
  const banner = new FakeElement();

  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    querySelector: () => banner,
  });

  Object.defineProperty(document, "cookie", {
    get: () => [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
    set: (cookie: string) => {
      writes.push(cookie);
      const [pair = ""] = cookie.split(";");
      const [key = "", value = ""] = pair.split("=");
      jar.set(key, value);
    },
  });
  const window = new FakeWindow();

  const localStorage = {
    getItem(key: string) {
      if (blocked) throw new Error("Storage blocked");

      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (blocked) throw new Error("Storage blocked");
      storage.set(key, value);
    },
    removeItem(key: string) {
      if (blocked) throw new Error("Storage blocked");
      storage.delete(key);
    },
  };

  runInNewContext(source, {
    window,
    document,
    localStorage,
    location: { hostname, protocol: "https:" },
    Event,
    CustomEvent,
    Element: FakeElement,
    HTMLElement: FakeElement,
  });
  assert.ok(window.widefleetConsent);

  return { window, document, consent: window.widefleetConsent, jar, storage, writes, banner };
}

test("a new reader remains undecided without storing an implicit rejection", () => {
  const page = browser();
  assert.equal(page.consent.get(), null);
  assert.equal(page.window.blumeConsent.analytics, false);
  assert.equal(page.banner.hidden, false);
  assert.equal(page.jar.size, 0);
  assert.equal(page.storage.size, 0);
});

test("website and docs share a host-only choice before analytics initialization", () => {
  const site = browser({ hostname: "widefleet.com" });
  site.consent.set("granted");
  assert.doesNotMatch(site.writes.at(-1) ?? "", /Domain=/);
  assert.match(site.writes.at(-1) ?? "", /Path=\/; Max-Age=15552000; SameSite=Lax; Secure/);
  const docs = browser({ jar: site.jar });
  assert.equal(docs.consent.get(), "granted");
  assert.equal(docs.window.blumeConsent.analytics, true);
  assert.equal(docs.banner.hidden, true);
});

test("a shared rejection overrides an older local grant, in either direction", () => {
  for (const hostname of ["widefleet.com", "www.widefleet.com"]) {
    const page = browser({
      hostname,
      jar: new Map([["widefleet-consent", "denied"]]),
      storage: new Map([["blume-consent", "granted"]]),
    });

    assert.equal(page.consent.get(), "denied");
    assert.equal(page.window.blumeConsent.analytics, false);
    assert.equal(page.storage.get("blume-consent"), "denied");
  }
});

test("missing or expired cookies never revive local consent", () => {
  const first = browser({
    storage: new Map([["blume-consent", "granted"]]),
  });

  assert.equal(first.consent.get(), null);
  assert.equal(first.window.blumeConsent.analytics, false);
  assert.equal(first.storage.has("blume-consent"), false);
  first.consent.set("granted");
  assert.equal(first.jar.get("widefleet-consent"), "granted");
  first.jar.clear();
  const expired = browser({ jar: first.jar, storage: first.storage });
  assert.equal(expired.consent.get(), null);
  assert.equal(expired.window.blumeConsent.analytics, false);
  assert.equal(expired.banner.hidden, false);
});

test("withdrawal stops analytics before Blume can reload the page", () => {
  const page = browser();
  page.consent.set("granted");
  const calls: string[] = [];
  Object.assign(page.window, { posthog: { opt_out_capturing: () => calls.push("opt-out") } });
  page.window.addEventListener("widefleet:consent", () => calls.push("consent-event"));
  page.window.blumeConsent.set = () => calls.push("blume-reload");
  page.consent.set("denied");
  assert.deepEqual(calls, ["opt-out", "consent-event", "blume-reload"]);
});

test("an already open page applies withdrawal when it regains focus", () => {
  const first = browser();
  first.consent.set("granted");
  const second = browser({ jar: first.jar, hostname: "widefleet.com" });
  second.consent.set("denied");
  first.window.dispatchEvent(new Event("focus"));
  assert.equal(first.consent.get(), "denied");
  assert.equal(first.window.blumeConsent.analytics, false);
  assert.equal(first.banner.hidden, true);
});

test("production, previews and localhost always write host-only preferences", () => {
  for (const hostname of [
    "widefleet.com",
    "www.widefleet.com",
    "preview.widefleet.com",
    "localhost",
  ]) {
    const page = browser({ hostname });
    assert.equal(page.consent.get(), null);
    page.consent.set("denied");
    assert.match(page.writes.at(-1) ?? "", /^widefleet-consent=denied; Path=\//);
    assert.doesNotMatch(page.writes.at(-1) ?? "", /Domain=/);
  }
});

test("cookie consent still works when localStorage is blocked", () => {
  const page = browser({ blocked: true });
  page.consent.set("granted");
  assert.equal(page.consent.get(), "granted");
  assert.equal(page.window.blumeConsent.analytics, true);
  const returning = browser({ jar: page.jar, blocked: true });
  assert.equal(returning.consent.get(), "granted");
});
