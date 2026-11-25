---
title: Encryption keys
description: Configure, add, re-encrypt with and back up the keys that protect stored secrets.
lastModified: 2026-11-25
---

Widefleet encrypts the secrets it stores in PostgreSQL: app secrets, company SSO and directory client secrets, and the client secret of app sign-in. Only the installation's encryption keys can read them. This page shows how to manage the keys, add a key version, move stored secrets to it, upgrade from the format of earlier releases and back up the keys.

## How the keyring works

The control plane reads its keys from a keyring with one or more key versions. The first version encrypts new values. The other versions only decrypt values written with them. Each stored value names the key version that encrypted it, so adding a version never makes existing values unreadable.

Without configuration, the control plane creates the keyring `encryption.keys` in the `platform-state` volume on its first start and logs its path. No setup is needed. To keep the keys in your own secret store, [manage the keyring yourself](#manage-the-keyring-yourself).

Cloudflare installations have no generated keyring; see [Cloudflare installations](#cloudflare-installations).

## Manage the keyring yourself

Set `PLATFORM_ENCRYPTION_KEYS` in the deployment environment to a private JWK Set (RFC 7517) on one line, with the active key first:

```sh
PLATFORM_ENCRYPTION_KEYS='{"keys":[{"kty":"oct","kid":"2026-11","k":"<new key>"},{"kty":"oct","kid":"2026-05","k":"<earlier key>"}]}'
```

Each entry of `keys` is one key version:

- `kty`: always `oct`.
- `kid`: the key version ID, 1 to 32 letters, digits, `-` or `_`. Use a new ID for every version, such as the month you created it.
- `k`: 32 random bytes in base64url without padding. Generate one with:

  ```sh
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
  ```

Every version needs its own ID and its own key. Other JWK members, such as `alg` or `use`, are ignored. When the control plane runs outside the reference Compose deployment, you can instead set `PLATFORM_ENCRYPTION_KEYS_FILE` to the path of a file with the same content. Use one of the two settings.

If the control plane has already created `encryption.keys`, copy its keys into your keyring first. Print them on the installation's host:

```sh
docker compose ... exec control-plane cat /var/lib/widefleet/encryption.keys
```

Add its entries after your new active key, then recreate the control plane to apply the setting:

```sh
docker compose ... up -d control-plane
```

The control plane does not start while your keyring is missing a key version from `encryption.keys`. This keeps values written with the generated keyring readable. Once [no stored value uses](#re-encrypt-stored-secrets) those versions and no backup you may restore needs them, you can delete the file.

## Add a key version

Add a version when you want new values to use a new key, for example on a schedule or after a key may have been exposed.

1. Generate a key with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.
2. Put the new entry first in `keys`, followed by all existing entries.
3. Save the updated keyring in your secret store and with your [key backups](#back-up-the-keys).
4. Recreate the control plane with `docker compose ... up -d control-plane`.

New values now use the new version. Existing values stay encrypted with their earlier versions, which remain in the keyring to decrypt them. To move them to the new version, [re-encrypt stored secrets](#re-encrypt-stored-secrets).

## Re-encrypt stored secrets

Re-encryption moves every stored secret that an earlier key version protects to the active version. Run it on the installation's host:

```sh
docker compose ... exec control-plane node tools/secret-encryption.ts reencrypt
```

The command only changes the database, so the installation stays available. It reads the keys the control plane uses and never creates keys. It works through the stored secrets in batches and reports its progress, such as `Checked 100 rows`. Values that already use the active version are decrypted to verify them.

Each value is replaced only if it is unchanged since the command read it. A secret saved during the run keeps the saved value and is counted as `changed`. A value that the keyring cannot decrypt stays unchanged and is counted as `failed`. When the run ends, the command prints its result and the number of stored secrets per key version:

```json
{
  "reencrypted": 15,
  "changed": 0,
  "failed": 0,
  "status": {
    "activeKeyVersion": "2026-11",
    "keyVersions": { "2026-11": 15, "2026-05": 0 },
    "failed": 0
  }
}
```

The command exits with status 1 if a value could not be decrypted or if a value still uses another key version. Run it again until it exits with status 0; it continues with whatever remains.

To see the counts without changing anything, run `node tools/secret-encryption.ts status` the same way. It exits with status 1 if a stored value cannot be decrypted.

## Remove an earlier key version

1. [Re-encrypt stored secrets](#re-encrypt-stored-secrets) until the command exits with status 0 and the version shows 0 secrets.
2. On Cloudflare installations, [check that no deployment is still running](#cloudflare-installations).
3. Wait until no backup you may restore still needs the version. Backups taken before re-encryption contain values written with it.
4. Remove the entry from `PLATFORM_ENCRYPTION_KEYS`, and from your key backups once they no longer need it.
5. Recreate the control plane with `docker compose ... up -d control-plane`.
6. Run `node tools/secret-encryption.ts status`. It must show `"failed": 0`.

## Cloudflare installations

On Cloudflare, `PLATFORM_ENCRYPTION_KEYS` is a required secret of the hosted deployment, in the same JWK Set format. The deployment stops before it changes anything if the secret is missing or malformed, and the control plane does not start without it. Generate the first key with the command above and keep the keyring in your deployment pipeline's secret store. Add and remove key versions there, then deploy through your normal versioned deployment process.

Run re-encryption from the deployment pipeline, in a checkout of the deployed release with its dependencies installed. Set the same `DATABASE_URL` and `PLATFORM_ENCRYPTION_KEYS` that the deployment uses. While values in the [format of earlier releases](#upgrade-from-earlier-releases) remain, also set `PLATFORM_ENCRYPTION_KEY`. Pass them as environment variables from the secret store, not as command arguments:

```sh
cd apps/control-plane
node tools/secret-encryption.ts reencrypt
```

Deployments that were accepted but have not finished carry their template secrets encrypted with the key version that was active when they started. Before you remove an earlier key version, check that no deployment Workflow instance is queued, running or paused. Run this in the same checkout with the pipeline's Cloudflare credentials; `<installation>` is the `name` of the hosted installation profile:

```sh
for status in queued running paused; do
  pnpm exec wrangler workflows instances list <installation>-deployments --status "$status"
done
```

Wait until the lists are empty, then remove the key version.

## Upgrade from earlier releases

Releases before the encryption keyring stored secrets in an earlier format, under one installation key: `encryption.key` in `platform-state`, or the key set with `PLATFORM_ENCRYPTION_KEY` or `PLATFORM_ENCRYPTION_KEY_FILE`. Releases with the keyring still read that format but write only with the keyring. The release that removes the earlier format refuses to start while any stored secret still uses it.

1. Upgrade to a release with the keyring and keep the earlier key in place. On Cloudflare, add `PLATFORM_ENCRYPTION_KEYS` to the deployment secrets and keep `PLATFORM_ENCRYPTION_KEY`.
2. [Re-encrypt stored secrets](#re-encrypt-stored-secrets) until the command exits with status 0. Its output counts values in the earlier format as `legacy`; the count must be 0.
3. Upgrade to the release that removes the earlier format.

If a value in the earlier format remains, the database migration of that release stops the upgrade with `Stored secrets still use the encryption format of earlier releases` and leaves the database unchanged. Start the previous release again, re-encrypt, then upgrade.

After the upgrade, the control plane no longer reads the earlier key. Remove `PLATFORM_ENCRYPTION_KEY` from the configuration, but keep a copy while you may restore a backup taken before re-encryption. To restore such a backup, restore it on a release with the keyring, re-encrypt, then upgrade again.

## Back up the keys

Restoring a database requires every key version that encrypted values in it. Without them, stored secrets cannot be decrypted.

- **Store the keys apart from database backups**, for example in a password manager or secret store with its own access. A leaked database backup then exposes no secrets, and losing the backup location does not take the keys with it.
- Update this copy every time you add a key version, before you rely on new database backups.
- The [whole-installation backup](/self-hosting/installation#whole-installation-backup-and-restore) archives `platform-state`, including `encryption.keys`. Encrypt the archive and restrict access to it.
- Keep every key version that a backup you may restore still uses.

## Troubleshooting

**The control plane does not start and names `PLATFORM_ENCRYPTION_KEYS`.** The value is not a JWK Set, an entry does not follow the format above, or a key version ID or key appears twice. The message names the entry or version, never the key. Correct it and generate replacement keys with the command above.

**"The configured encryption keyring must include every key version in …/encryption.keys".** Copy the entries from that file into your keyring, as in [Manage the keyring yourself](#manage-the-keyring-yourself).

**"Stored credentials could not be decrypted. Restore the installation encryption key.", or `failed` is not 0.** A stored value uses a key version that the keyring does not have, for example after restoring a database without its keys. Add the missing version back to the keyring and recreate the control plane. For values in the [format of earlier releases](#upgrade-from-earlier-releases), restore `encryption.key` or `PLATFORM_ENCRYPTION_KEY`. Then run `node tools/secret-encryption.ts status` again.

**"No encryption keyring found".** The command runs where neither `PLATFORM_ENCRYPTION_KEYS` nor `encryption.keys` is available. Run it inside the control-plane container, or set the deployment's keyring in its environment.
