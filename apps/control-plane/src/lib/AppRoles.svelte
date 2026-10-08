<script lang="ts">
  import { appRoleState } from "@platform/contracts";
  import type { z } from "zod";
  import { grantAppRole, revokeAppRole, transferAppOwnership } from "#lib/app-roles.remote";
  import { searchAccessGroups } from "#lib/app-access.remote";
  import type { getAppDetails } from "#lib/apps.remote";
  import FormIssues from "./FormIssues.svelte";

  let { appId, data, candidates, search }: { appId: string; data: z.infer<typeof appRoleState>; candidates: Awaited<ReturnType<typeof getAppDetails>>["candidates"]; search: string } = $props();

  const grant = $derived(grantAppRole.for(appId));

  const transfer = $derived(transferAppOwnership.for(appId));

  const directory = $derived(searchAccessGroups.for(appId));

  let type = $state<"user" | "group">("group");

  let subject = $state("");

  let selectedProvider = $state<string | undefined>();

  const provider = $derived(selectedProvider ?? data.provider);

  const labels = { user: "Nutzer", developer: "Entwickler", admin: "App-Admin", owner: "Owner" };

  const editable = $derived(data.inheritedFrom === null && data.actions.includes("roles"));

  function choose(person: { type: "user" | "group"; provider: string; subject: string }) {
    type = person.type; selectedProvider = person.provider; subject = person.subject;
  }
</script>
<section id="access">
  <h2>Rollen und Eigentümerschaft</h2>
  <p>Nutzer verwenden die App. Entwickler können zusätzlich deployen, Logs lesen, Versionen wiederherstellen und Datenbankmigrationen ausführen. App-Admins verwalten außerdem Rollen, Netzwerkfreigaben und Katalogeintrag und können die App löschen. Der Owner kann die Eigentümerschaft übertragen.</p>
  {#if data.inheritedFrom}<p>Die Rollen werden von der <a href={`/apps/${data.inheritedFrom}#access`}>ursprünglichen App</a> übernommen.</p>{/if}
  <ul class="records">
    {#each data.assignments as assignment (assignment.id)}
      <li><div><strong>{labels[assignment.role]}</strong> · {assignment.principal.type === "group" ? "Gruppe" : "Person"}<p><code>{assignment.principal.subject}</code></p><p class="muted">{assignment.principal.provider}</p></div>
        {#if editable && assignment.role !== "owner"}
          {@const revoke = revokeAppRole.for(assignment.id)}
          <form {...revoke}>
            <input {...revoke.fields.appId.as("hidden", appId)} /><input {...revoke.fields.assignmentId.as("hidden", assignment.id)} />
            <input {...revoke.fields.revision.as("hidden", data.revision)} /><input {...revoke.fields.search.as("hidden", search)} />
            <FormIssues issues={revoke.fields.allIssues()} /><button class="secondary" disabled={revoke.pending > 0}>Rolle entziehen</button>
          </form>
        {/if}
      </li>
    {/each}
  </ul>
  {#if editable}
    <form method="GET" action="#access"><label for="member-search">Person nach Name oder E-Mail suchen</label><input id="member-search" name="q" value={search} maxlength="200" required /><button class="secondary">Person suchen</button></form>
    {#if search && !candidates.length}<p>Keine Mitglieder gefunden.</p>{/if}
    <ul class="records">{#each candidates as person (`${person.principal.provider}:${person.principal.subject}`)}
      {@const memberGrant = grantAppRole.for(`member:${person.principal.subject}`)}
      <li><div><strong>{person.name}</strong><p>{person.email}</p></div>
        <form {...memberGrant}>
          <input {...memberGrant.fields.appId.as("hidden", appId)} /><input {...memberGrant.fields.revision.as("hidden", data.revision)} /><input {...memberGrant.fields.search.as("hidden", search)} />
          <input {...memberGrant.fields.type.as("hidden", "user")} /><input {...memberGrant.fields.provider.as("hidden", person.principal.provider)} /><input {...memberGrant.fields.subject.as("hidden", person.principal.subject)} />
          <label>Rolle für {person.name}<select {...memberGrant.fields.role.as("select")}><option value="user">Nutzer</option><option value="developer">Entwickler</option><option value="admin">App-Admin</option></select></label>
          <FormIssues issues={memberGrant.fields.allIssues()} /><button disabled={memberGrant.pending > 0}>Rolle an {person.name} vergeben</button>
        </form>
        {#if data.actions.includes("transfer")}
          {@const memberTransfer = transferAppOwnership.for(`member:${person.principal.subject}`)}
          <details><summary>{person.name} als Owner einsetzen</summary>
            <form {...memberTransfer}>
              <input {...memberTransfer.fields.appId.as("hidden", appId)} /><input {...memberTransfer.fields.revision.as("hidden", data.revision)} /><input {...memberTransfer.fields.type.as("hidden", "user")} /><input {...memberTransfer.fields.provider.as("hidden", person.principal.provider)} /><input {...memberTransfer.fields.subject.as("hidden", person.principal.subject)} />
              <p>Deine bisherigen Owner-Rechte enden mit der Übergabe.</p><FormIssues issues={memberTransfer.fields.allIssues()} /><button disabled={memberTransfer.pending > 0}>An {person.name} übertragen</button>
            </form>
          </details>
        {/if}
      </li>
    {/each}</ul>
    <details><summary>Gruppe im Firmenverzeichnis suchen</summary>
      <form {...directory}><input {...directory.fields.appId.as("hidden", appId)} /><label for="group-search">Gruppenname</label><input id="group-search" {...directory.fields.query.as("search")} required /><FormIssues issues={directory.fields.allIssues()} /><button class="secondary" disabled={directory.pending > 0}>Gruppen suchen</button></form>
      {#if directory.result}<ul class="records">{#each directory.result.groups as group (group.id)}<li><div><strong>{group.name}</strong><p><code>{group.id}</code></p></div><button type="button" class="secondary" onclick={() => choose({ type: "group", provider: data.provider, subject: group.id })}>Gruppe auswählen</button></li>{/each}</ul>{/if}
    </details>
    <form {...grant}>
      <input {...grant.fields.appId.as("hidden", appId)} /><input {...grant.fields.revision.as("hidden", data.revision)} /><input {...grant.fields.search.as("hidden", search)} /><input {...grant.fields.provider.as("hidden", provider)} />
      <label for="principal-type">Berechtigter</label><select id="principal-type" {...grant.fields.type.as("select")} bind:value={type} onchange={() => { selectedProvider = undefined; subject = ""; }}><option value="group">SSO-Gruppe</option><option value="user">Person</option></select>
      <label for="principal-subject">Stabile ID</label><input id="principal-subject" {...grant.fields.subject.as("text")} bind:value={subject} required maxlength="256" />
      <label for="app-role">Rolle</label><select id="app-role" {...grant.fields.role.as("select")}><option value="user">Nutzer</option><option value="developer">Entwickler</option><option value="admin">App-Admin</option></select>
      <FormIssues issues={grant.fields.allIssues()} /><button disabled={grant.pending > 0}>Rolle vergeben</button>
      {#if grant.result?.saved}<p role="status">Rolle gespeichert. Der App-Zugang wird nach Übernahme der Regeln wirksam.</p>{/if}
    </form>
    {#if data.actions.includes("transfer")}
      <details><summary>Eigentümerschaft übertragen</summary><p>Die angegebene Person oder Gruppe wird direkt Owner. Deine bisherigen Owner-Rechte enden mit der Übergabe; andere Rollenzuweisungen bleiben bestehen.</p>
        <form {...transfer}>
          <input {...transfer.fields.appId.as("hidden", appId)} /><input {...transfer.fields.revision.as("hidden", data.revision)} /><label>Neuer Owner ist<select {...transfer.fields.type.as("select")}><option value="group">SSO-Gruppe</option><option value="user">Person</option></select></label><input {...transfer.fields.provider.as("hidden", data.provider)} /><label>Stabile ID des neuen Owners<input {...transfer.fields.subject.as("text")} required maxlength="256" /></label>

          <FormIssues issues={transfer.fields.allIssues()} /><button disabled={transfer.pending > 0}>Eigentümerschaft übertragen</button>
        </form>
      </details>
    {/if}
  {/if}
</section>
