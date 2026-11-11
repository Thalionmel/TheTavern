# The Tavern

A shared tabletop campaign hub for one game master and five players. The first working slice is **accounts, campaign rooms, and live dice rolls with server-enforced visibility**.

Cloudflare deployment: **[Open The Tavern](https://the-tavern.the-tavern.workers.dev)**. Create a room to become its GM, then share its invitation with the other five players. Each person chooses their own name and password.

## Run locally

Requires **Node.js 22.14 or newer**. Cloudflare is the chosen hosting target. Its runtime can be tested locally without an account:

```sh
npm ci
npm run dev:cloudflare
```

Open <http://127.0.0.1:8787>. Wrangler keeps local campaign data in the ignored `.wrangler/` directory. This is a local simulation; it does not publish a website or upload your data.

The original standalone Node server is also available, without installing packages:

```sh
npm start
```

For that server, open <http://127.0.0.1:3000>. In either version, create a room to become its GM, then copy the invitation link. Friends join with their own names and passwords. Existing members use **Sign in**, with the same room code and account details.

Use separate browser profiles, different browsers, or a private browser window to test two accounts on one computer. Tabs in the same browser profile share their signed-in account. Two accounts must connect to **the same server** to share rolls; running separate app copies creates separate tables.

Both local previews listen only on `127.0.0.1`. For a trusted LAN test of the standalone Node server, set `HOST=0.0.0.0` and use the host computer's LAN address on both devices. Use an HTTPS origin or an encrypted private network before sending real account passwords remotely.

Standalone Node configuration: copy `.env.example` to `.env`. `HOST`, `PORT`, `DATABASE_PATH`, and `APP_ORIGIN` are supported. Configure `APP_ORIGIN` to the exact public HTTPS origin when using a reverse proxy. A configured HTTPS origin enables Secure session cookies and HSTS. The proxy must preserve `/api/events` server-sent event streaming. Cloudflare uses `wrangler.jsonc`, its request origin and WebSockets instead; it does not use these `.env` settings.

## First version

- Create a campaign; join with an invitation code; sign out and back in.
- Six accounts per campaign: the creator is GM; joiners are players.
- Live presence and a draggable, resizable, minimizable Dice window. Full-window mode and a mobile layout are included.
- Dice expressions such as `1d20`, `3d20`, `2d6+4`, and `1d20-2`. Individual values and the total are retained; these are generic rolls, not automated DSA skill checks.
- Up to 20 dice per roll, 2–1000 sides, and modifiers from −10000 to +10000.
- **Public:** everyone in this campaign, including members who join later.
- **Only me:** just the account that rolled; even the GM is excluded.
- **To GM:** the account that rolled and the campaign's GM.
- The latest 100 authorized rolls are loaded on entry/reconnect. The database retains older rolls; there is no archive UI yet.
- The server generates dice with `crypto.randomInt`; clients cannot supply results, author identity, room identity, or roles.
- Other hub elements are clearly marked **Coming later** and are not implemented yet.

Changing the visibility choice affects the **next** roll. A completed roll keeps its original audience.

## Storage and account boundaries

SQLite stores rooms, salted scrypt password hashes, hashed session tokens, and rolls. The standalone Node server uses `data/tavern.sqlite`. Cloudflare uses one SQLite-backed Durable Object per campaign, with a separate Durable Object for each IP's authentication rate limit. Session cookies are HttpOnly and SameSite=Strict and expire after seven days; HTTPS adds Secure. Signing out revokes the session and ends its open event connections. Accounts and history survive a runtime restart.

On Cloudflare, authenticated WebSockets deliver personalized updates. Connections can hibernate between events. Browser keepalive pings use Cloudflare's automatic response API, so they do not wake the campaign object; no server-side heartbeat interval runs. An alarm handles session expiry, and every broadcast checks the current stored session before sending a result.

The standalone database, local Wrangler state and deployed Cloudflare state are **separate datasets**. There is no automatic import/export tool yet. Existing `data/tavern.sqlite` is left untouched and is never uploaded by deployment.

Visibility is applied to both database queries and live delivery. Hidden results are not sent to unauthorized clients. **Only me** is an application-level privacy rule: the machine/database operator can still access stored records. Data is not end-to-end encrypted.

This first version has no password recovery, invitation rotation, member removal, account deletion, or GM transfer screen. Keep the invitation within the six-person group. Those administration features should precede wider public use. Cloudflare persists limits of 10 room-creation attempts and 30 join/sign-in attempts per minute per IP, and 60 rolls per minute per account. People sharing an internet connection share authentication limits. The standalone server has per-process rate limits.

Only the server should access `data/`; keep it out of source control and never put it in a public static directory. Back up SQLite using its backup API or stop the server before copying its database. Copying only a live `.sqlite` file can miss changes in the WAL.

## Verify

```sh
npm test
```

Run `npm ci` first. Tests first bundle the Cloudflare Worker using a deployment dry run, then exercise both backends. They use independent account cookies, real HTTP/SSE connections for Node, and the local Cloudflare runtime with WebSockets. They cover public delivery, private and GM-only exclusions, reconnect/history, room isolation, forged identities/roles, six-seat limits, authentication, origin validation, dice bounds, logout and persistence across restart. Cloudflare tests also force hibernation, check rate limits, and verify session expiry. They create isolated temporary data and do not touch your campaign database.

## Hosting

The selected path is **Cloudflare Workers with static assets and SQLite-backed Durable Objects**. One campaign object owns its accounts, history and live connections. There is no separate database subscription or always-on server to manage. See [the hosting and setup guide](docs/hosting.md).

The Cloudflare Free plan is the initial target, subject to its usage limits. A supplied `workers.dev` HTTPS address avoids buying a domain. R2 or AWS S3 can be added later for maps and documents; neither is required or configured for dice.

The standalone fallback still needs one Node process and persistent disk with HTTPS for internet access. GitHub Pages cannot run either backend. The Worker and its two SQLite-backed Durable Object namespaces are deployed in the account pinned by `wrangler.jsonc`. No paid subscription, custom domain, AWS resources or Discord integration was added. GitHub Actions validates changes; publishing updates remains a separate Wrangler command.
