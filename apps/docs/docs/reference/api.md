---
title: API and uploads
description: Authentication, app publication and the Worker upload contract.
---

Authenticated clients can fetch `/api/v1/openapi.json`. The document covers management operations, agent jobs, binary assets and multipart Workers.

Clients must send `Origin: <PLATFORM_URL>` for OAuth form requests and Worker uploads. SvelteKit's CSRF protection and Better Auth's protections remain enabled.

1. Resolve or create the configured name with `PUT /api/v1/apps/by-name/{slug}`. The server checks permissions and assigns the deployment host on creation. Explicit `POST /api/v1/apps` remains available for previews and administrative scripts.
2. Submit an asset manifest to `/api/v1/apps/{appId}/assets-upload-session`.
3. Upload each missing hash to the returned session's asset endpoint. The API verifies both bytes and declared size.
4. Upload the Worker as multipart data to `/api/v1/apps/{appId}/worker` with a UUID `Idempotency-Key` header. Include one JSON `metadata` field and file parts named after their modules.
5. Follow the app's deployment history and events. An upload is queued, not active, until its agent reports successful activation.

Upload sessions expire after one hour. Repeating an identical publish within its valid session returns the original deployment. A session's Worker content is immutable. Asset hashes follow Wrangler's BLAKE3 algorithm over base64 content plus the case-sensitive file extension; modules use SHA-256. Preview apps have separate identities and artifact prefixes.

Rollback queues a retained artifact from the same app. It does not restore older database or file contents. Deletion marks the app unwritable and queues teardown after earlier jobs; management records and artifacts are removed after the agent confirms teardown.

See [CLI authentication](/reference/authentication) for credentials, [CLI reference](/reference/cli) for command output, and [runtime](/reference/runtime) for activation and removal behavior.
