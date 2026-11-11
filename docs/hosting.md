# Hosting The Tavern on Cloudflare

Cloudflare is the selected host. Checked against official documentation on **11 November 2026**. No account, subscription or public deployment has been created. Local tests do not establish production latency or actual billable usage.

## What runs where

| Part | Cloudflare service | Current behavior |
| --- | --- | --- |
| Hub interface | Worker static assets | Serves HTML, CSS and JavaScript. Only `/api/*` and `/healthz` run the Worker first. |
| HTTP entry point | Worker | Validates requests and routes each campaign to its own Durable Object. |
| Accounts and dice history | SQLite-backed Durable Object per campaign | Generates results, persists accounts/sessions/rolls and filters history by audience. |
| Live results and presence | Hibernating WebSockets in the campaign object | Filters messages by stored session and audience; connections remain open while the object sleeps. |
| Authentication rate limits | SQLite-backed Durable Object per IP | Keeps limits across runtime eviction without continuous timers. |
| Maps and attachments | Future R2 or AWS S3 integration | No buckets, upload endpoints or storage credentials are configured. |

`wrangler.jsonc` binds `CampaignRoom` and `RequestGuard` and creates their SQLite namespaces in migration `v1`. SQLite-backed objects support the Free plan; do not replace this with a legacy KV-backed class migration.

## Initial cost target

For one six-person campaign, **$0 hosting is a reasonable starting estimate**, not a measured guarantee. Start on Workers Free and review actual usage after a real session.

| Service | Relevant Free allowance |
| --- | --- |
| Worker static assets | Free, unlimited asset requests; no additional asset storage charge. |
| Worker requests | 100,000 requests/day, subject to CPU/runtime limits. |
| Durable Object compute | 100,000 requests/day and 13,000 GB-s/day. Hibernating time is excluded from duration billing. |
| SQLite Durable Object storage | 5 GB total, 5 million rows read/day and 100,000 rows written/day. Index updates also contribute to writes. |
| Domain | The supplied `workers.dev` HTTPS address is sufficient. A custom domain is optional and priced separately. |

These are account-level plan limits, not allocations exclusively for The Tavern. Free limits can stop requests until they reset; upgrading to a paid plan changes the billing model. Avoid enabling paid services merely to test this room.

For scale: six people each rolling 100 times in one session create 600 rolls. Roll submission and live delivery produce requests and SQL activity; session checks, presence, history reloads and indexes add overhead. That workload appears comfortably below the listed daily allowances, but only a deployed session can confirm actual usage. Password hashing runs in the Durable Object runtime and must also be checked on the live deployment.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

## Test locally without an account

Requires Node.js 22.14 or newer:

```sh
npm ci
npm test
npm run dev:cloudflare
```

Open <http://127.0.0.1:8787>. Create a room, then use another browser profile/private window to join as a second account. Verify Public reaches both, Only me stays with the roller, and To GM reaches the roller and GM. Multiple tabs in one profile share a session.

Wrangler stores local state in `.wrangler/`. The original Node preview on port 3000 and its `data/tavern.sqlite` remain independent. Deployment does not copy either local dataset online. Do not delete these directories if their campaign data matters.

## First online deployment

The account owner first creates a [Cloudflare account](https://dash.cloudflare.com/sign-up), verifies their email and selects Workers Free. No custom domain is required. After the intended account is confirmed, authenticate from this repository:

```sh
npx wrangler login
npx wrangler whoami
```

Confirm the account shown by `whoami` is the intended personal account. If more than one account is available, set the confirmed `account_id` in `wrangler.jsonc` before deployment. Then:

```sh
npm test
npm run deploy:cloudflare
```

The deployment creates the Worker and its Durable Object namespaces and returns its HTTPS URL. If Cloudflare asks for a Workers subdomain, choose it in that account. There are no application secrets or database IDs to provision for this first slice.

On the real URL, create test GM/player accounts in separate browser profiles and repeat the three visibility checks, reload, sign out and sign back in. Check dashboard usage and authentication behavior before moving the group's campaign there. Published data persists across normal Worker updates; changes to existing migrations or namespace bindings need a deliberate data migration. Application-level export and restore are not implemented yet, so use test data until the backup/recovery workflow is agreed.

GitHub Actions runs validation only. It does not deploy and has no Cloudflare credentials. Automatic deployment can be connected later after the account and first deployment are verified.

## Later storage and voice

Structured character sheets, notes, NPC records and map reveal state can live with the campaign's database when those features are implemented. Larger map images and documents belong in object storage. R2 is a convenient first option and offers an S3-compatible API; AWS S3 remains possible if there is a concrete reason to use it.

R2 Standard currently includes 10 GB-month storage, 1 million Class A operations and 10 million Class B operations monthly, with no internet egress charge. Enabling R2 and any billing requirements should be a separate decision when uploads are implemented. AWS S3 has its own storage, request and transfer costs; no AWS account access is needed now. GM-only assets must use authorized retrieval, rather than public bucket URLs, to preserve future map secrecy.

Sources: [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/).

Keep Discord for voice/video initially. The app currently has neither embedded Discord calls nor its own voice/video service. Railway remains a fallback for the standalone Node backend if the project later needs an always-running process; that option needs a persistent volume and a separate hosting budget.
