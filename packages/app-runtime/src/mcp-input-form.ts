// The form that asks a person for input inside MCP clients that render MCP
// Apps but cannot show the question in a dialog of their own. It speaks the
// MCP Apps postMessage protocol directly, so the page has no dependencies.
// Only the form calls the `answer` tool, which hosts hide from the model.

export const inputFormUri = "ui://widefleet/input-form.html";

export const inputFormMimeType = "text/html;profile=mcp-app";

// Tool results carry the form's question here; hosts pass `_meta` to the view
// but not to the model.
export const inputFormMetaKey = "widefleet/input";

const script = String.raw`
const metaKey = ${JSON.stringify(inputFormMetaKey)};
const root = document.getElementById("form");
const status = document.getElementById("status");
const pending = new Map();
let nextId = 1;
let host = {};
let done = false;

const send = (message) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

const element = (name, properties = {}, children = []) => {
  const node = Object.assign(document.createElement(name), properties);
  node.append(...children);
  return node;
};

const applyContext = (context) => {
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
  for (const [name, value] of Object.entries(context.styles?.variables ?? {}))
    if (typeof value === "string") document.documentElement.style.setProperty(name, value);
  if (typeof context.styles?.css?.fonts === "string")
    document.head.append(element("style", { textContent: context.styles.css.fonts }));
};

const field = (name, schema, required) => {
  const id = "field-" + name;
  let control;

  if (schema.type === "boolean") {
    control = element("input", { type: "checkbox", id, name, checked: schema.default === true });
  } else if (schema.type === "string" && schema.enum) {
    control = element("select", { id, name, required }, [
      ...(required ? [] : [element("option", { value: "", textContent: "" })]),
      ...schema.enum.map((value, index) =>
        element("option", {
          value,
          textContent: schema.enumNames?.[index] ?? value,
          selected: schema.default === value,
        }),
      ),
    ]);
  } else if (schema.type === "string") {
    const type = { email: "email", uri: "url", date: "date", "date-time": "datetime-local" }[schema.format] ?? "text";
    control = element("input", { type, id, name, required });
    if (schema.minLength !== undefined) control.minLength = schema.minLength;
    if (schema.maxLength !== undefined) control.maxLength = schema.maxLength;
    if (schema.default !== undefined) control.value = schema.default;
  } else {
    control = element("input", { type: "number", id, name, required, step: schema.type === "integer" ? "1" : "any" });
    if (schema.minimum !== undefined) control.min = String(schema.minimum);
    if (schema.maximum !== undefined) control.max = String(schema.maximum);
    if (schema.default !== undefined) control.value = String(schema.default);
  }

  const label = element("label", { htmlFor: id, textContent: schema.title ?? name });
  const description = schema.description ? [element("small", { textContent: schema.description })] : [];

  return {
    node: element("div", { className: schema.type === "boolean" ? "field check" : "field" },
      schema.type === "boolean" ? [control, label, ...description] : [label, control, ...description]),
    value: () => {
      if (schema.type === "boolean") return control.checked;
      if (control.value === "") return undefined;
      if (schema.type === "number" || schema.type === "integer") return Number(control.value);
      if (schema.format === "date-time") return new Date(control.value).toISOString();
      return control.value;
    },
  };
};

const finish = async (text) => {
  done = true;
  root.replaceChildren();
  status.textContent = "Answer sent.";
  const content = [{ type: "text", text }];
  // The model learns the outcome from the host; hosts differ in which path they offer.
  if (host.updateModelContext) await request("ui/update-model-context", { content }).catch(() => {});
  if (host.message)
    await request("ui/message", {
      role: "user",
      content: host.updateModelContext ? [{ type: "text", text: "I answered the form." }] : content,
    }).catch(() => {});
};

const show = (question) => {
  const groups = Object.entries(question.inputRequests).map(([name, request]) => {
    const required = request.requestedSchema.required ?? [];
    const fields = Object.entries(request.requestedSchema.properties).map(([key, schema]) => [
      key,
      field(key, schema, required.includes(key)),
    ]);
    return {
      name,
      fields,
      node: element("fieldset", {}, [
        element("p", { className: "message", textContent: request.message }),
        ...fields.map(([, entry]) => entry.node),
      ]),
    };
  });

  const submit = element("button", { type: "submit", textContent: "Submit" });
  const decline = element("button", { type: "button", className: "secondary", textContent: "Decline" });
  const form = element("form", {}, [...groups.map((group) => group.node), element("div", { className: "actions" }, [submit, decline])]);

  const reply = async (action) => {
    submit.disabled = decline.disabled = true;
    status.textContent = "Sending…";
    const inputResponses = Object.fromEntries(
      groups.map((group) => [
        group.name,
        action === "accept"
          ? {
              action,
              content: Object.fromEntries(
                group.fields
                  .map(([key, entry]) => [key, entry.value()])
                  .filter(([, value]) => value !== undefined),
              ),
            }
          : { action },
      ]),
    );

    try {
      const result = await request("tools/call", {
        name: "answer",
        arguments: { ...question.call, requestState: question.requestState, inputResponses },
      });
      const text = (result?.content ?? []).filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
      const next = result?._meta?.[metaKey];
      if (next) {
        status.textContent = "";
        show(next);
      } else if (result?.isError) {
        status.textContent = text || "The answer was not accepted.";
        await finish("The person answered the form for " + question.call.method + ", but the call failed: " + text);
      } else {
        await finish("The person answered the form for " + question.call.method + ". Result: " + text);
      }
    } catch (error) {
      submit.disabled = decline.disabled = false;
      status.textContent = "Sending failed: " + (error instanceof Error ? error.message : String(error));
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    reply("accept");
  });
  decline.addEventListener("click", () => reply("decline"));
  root.replaceChildren(form);
};

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;

  if (message.method === undefined) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? "Request failed"));
    else entry.resolve(message.result);
    return;
  }

  if (message.method === "ui/notifications/tool-result") {
    const question = message.params?._meta?.[metaKey];
    if (question && !done) show(question);
    else if (!question) status.textContent = (message.params?.content ?? []).map((entry) => entry.text ?? "").join("\n");
  } else if (message.method === "ui/notifications/host-context-changed") applyContext(message.params ?? {});
  else if (message.method === "ui/resource-teardown" || message.method === "ping") send({ id: message.id, result: {} });
  else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});

let size = "";
new ResizeObserver(() => {
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  const width = Math.ceil(window.innerWidth);
  if (size === width + "x" + height) return;
  size = width + "x" + height;
  send({ method: "ui/notifications/size-changed", params: { width, height } });
}).observe(document.body);

const initialized = await request("ui/initialize", {
  appInfo: { name: "Widefleet input form", version: "1.0.0" },
  appCapabilities: {},
  protocolVersion: "2026-01-26",
});
host = initialized?.hostCapabilities ?? {};
applyContext(initialized?.hostContext ?? {});
send({ method: "ui/notifications/initialized" });
`;

export const inputFormHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
  color-scheme: light dark;
  --color-background-primary: light-dark(#ffffff, #171717);
  --color-background-secondary: light-dark(#f4f4f5, #262626);
  --color-text-primary: light-dark(#171717, #fafafa);
  --color-text-secondary: light-dark(#52525b, #a1a1aa);
  --color-border-primary: light-dark(#d4d4d8, #3f3f46);
  --color-background-inverse: light-dark(#171717, #fafafa);
  --color-text-inverse: light-dark(#fafafa, #171717);
  --font-sans: system-ui, sans-serif;
  --border-radius-md: 8px;
}
html, body { margin: 0; background: var(--color-background-primary); color: var(--color-text-primary); font: 15px/1.45 var(--font-sans); }
main { padding: 12px 16px; }
fieldset { border: 0; margin: 0 0 12px; padding: 0; }
.message { margin: 0 0 10px; white-space: pre-wrap; }
.field { display: grid; gap: 4px; margin-bottom: 10px; }
.field.check { grid-template-columns: auto 1fr; align-items: center; column-gap: 8px; }
.field.check small { grid-column: 2; }
label { font-weight: 600; }
small { color: var(--color-text-secondary); }
input:not([type=checkbox]), select { font: inherit; color: inherit; background: var(--color-background-primary); border: 1px solid var(--color-border-primary); border-radius: var(--border-radius-md); padding: 6px 8px; }
.actions { display: flex; gap: 8px; }
button { font: inherit; font-weight: 600; border: 1px solid transparent; border-radius: var(--border-radius-md); padding: 6px 14px; cursor: pointer; background: var(--color-background-inverse); color: var(--color-text-inverse); }
button.secondary { background: var(--color-background-secondary); color: var(--color-text-primary); border-color: var(--color-border-primary); }
button:disabled { opacity: 0.6; cursor: default; }
#status { margin: 0; color: var(--color-text-secondary); white-space: pre-wrap; }
</style>
</head>
<body>
<main>
<div id="form"></div>
<p id="status" role="status"></p>
</main>
<script type="module">${script.replaceAll("</", "<\\/")}</script>
</body>
</html>`;
