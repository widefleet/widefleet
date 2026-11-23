// Shared by the generated templates: the template generator copies this file into
// each template's src. Edit it in packages/template-generator/src/runtime.
import { type ApprovalLevel, approvalLevels, levelDescriptions } from "./approval.ts";

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** Styles of the approval form, added to the page's own styles. */
export const approvalStyles =
  "fieldset{border:0;margin:24px 0;padding:0}legend{font-weight:600;margin-bottom:8px;padding:0}input[type=radio]{margin:0}label{display:flex;gap:10px;align-items:center;padding:6px 0;cursor:pointer}.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#202124;color:white;border-radius:7px;padding:10px 18px;font-size:14px}.toast[hidden]{display:none}";

// Saves a new level at once. When saving fails, the page shows the stored level
// again, which the failed request may or may not have changed.
export const approvalForm = (service: string, level: ApprovalLevel) => `
<fieldset id="approval"><legend>Before ${escape(service)} changes run</legend>
${approvalLevels.map((option) => `<label><input type="radio" name="level" value="${option}"${option === level ? " checked" : ""}> ${escape(levelDescriptions[option])}</label>`).join("")}
<p class="muted">Applies when apps and agents change ${escape(service)} data with your account. Reading never asks.</p></fieldset>
<p class="toast" role="status" hidden></p>
<script>
const form = document.getElementById("approval");
const toast = document.querySelector(".toast");
let saved = form.querySelector("input:checked").value;
let latest = saved;
let saving = Promise.resolve();
const levels = ${JSON.stringify(approvalLevels)};
const restore = async (attempted) => {
  try {
    const response = await fetch("/approval-level");
    const { level } = response.ok ? await response.json() : {};
    if (levels.includes(level)) saved = level;
  } catch {}
  // A newer choice stays: the next save sends it.
  if (latest !== attempted) return;
  latest = saved;
  form.querySelector(\`input[value="\${saved}"]\`).checked = true;
  if (saved === attempted) return;
  toast.textContent = "The approval level could not be saved. Try again.";
  toast.hidden = false;
  setTimeout(() => (toast.hidden = true), 4000);
};
// Saves run one after another and each sends the latest choice, so the stored
// level always ends as the one the page shows.
form.addEventListener("change", (event) => {
  latest = event.target.value;
  saving = saving.then(async () => {
    const level = latest;
    if (level === saved) return;
    try {
      const response = await fetch("/approval-level", { method: "POST", body: new URLSearchParams({ level }) });
      if (response.ok) {
        saved = level;
        return;
      }
    } catch {}
    await restore(level);
  });
});
</script>`;
