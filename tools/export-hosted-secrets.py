"""Copy hosted credentials to 1Password without logging or persisting their values."""

import json
import os
import subprocess
import sys


def main():
    names = [
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_DEPLOY_TOKEN",
        "CLOUDFLARE_PROVISIONING_TOKEN",
        "DATABASE_URL",
        "BETTER_AUTH_SECRET",
        "PLATFORM_ENCRYPTION_KEY",
        "APP_COOKIE_SECRET",
        "WIDEFLEET_CONTROL_TOKEN",
        "WIDEFLEET_CONNECTOR_KEY",
    ]
    required = [*names, "OP_SERVICE_ACCOUNT_TOKEN", "DESTINATION_VAULT", "DESTINATION_ITEM"]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise RuntimeError("Missing required inputs: " + ", ".join(missing))

    values = {name: os.environ[name] for name in names}
    if os.environ.get("PLATFORM_BOOTSTRAP"):
        values["PLATFORM_BOOTSTRAP"] = os.environ["PLATFORM_BOOTSTRAP"]

    vault = os.environ["DESTINATION_VAULT"]
    title = os.environ["DESTINATION_ITEM"]
    # The CLI only needs its own credential. Item values travel over stdin.
    op_environment = {
        key: value for key, value in os.environ.items()
        if key not in {*names, "PLATFORM_BOOTSTRAP"}
    }

    def op(*arguments, item=None):
        result = subprocess.run(
            ["op", *arguments, "--format", "json"],
            input=json.dumps(item) if item is not None else None,
            capture_output=True,
            text=True,
            env=op_environment,
            check=False,
        )
        if result.returncode:
            # CLI errors can contain item data. Never forward raw stdout/stderr.
            raise RuntimeError("1Password command failed: " + " ".join(arguments[:2]))
        return json.loads(result.stdout)

    existing = [item for item in op("item", "list", "--vault", vault) if item["title"] == title]
    if len(existing) > 1:
        raise RuntimeError("Multiple destination items have this title; resolve the ambiguity first")

    if existing:
        item_id = existing[0]["id"]
    else:
        created = op("item", "create", "--vault", vault, "-", item={
            "title": title,
            "category": "SECURE_NOTE",
            "fields": [
                {
                    "id": name,
                    "label": name,
                    "type": "STRING" if name == "CLOUDFLARE_ACCOUNT_ID" else "CONCEALED",
                    "value": value,
                }
                for name, value in values.items()
            ],
        })
        item_id = created["id"]

    saved = op("item", "get", item_id, "--vault", vault)
    fields = {field["label"]: field.get("value", "") for field in saved.get("fields", [])}
    if any(fields.get(name) != value for name, value in values.items()):
        raise RuntimeError("Destination verification failed; no existing item was overwritten")
    print("Credentials copied and verified. Existing GitHub secrets and vault items were retained.")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Parsing and subprocess errors must not include secret values in a traceback.
        print("Credential transfer failed; sensitive command output was suppressed.", file=sys.stderr)
        sys.exit(1)
