# The Tavern

A shared tabletop campaign hub for one game master and five players. The current version includes **accounts, campaign rooms, live 3D dice and character documents with server-enforced visibility**.

Cloudflare deployment: **[Open The Tavern](https://the-tavern.the-tavern.workers.dev)**. Create a room to become its GM, then share its invitation with the other five players. Each person chooses their own name and password.

## Run locally

Requires **Node.js 22.14 or newer**. Cloudflare is the chosen hosting target. Its runtime can be tested locally without an account:

```sh
npm ci
npm run dev:cloudflare
```

Open <http://127.0.0.1:8787>. Wrangler keeps local campaign data in the ignored `.wrangler/` directory. This is a local simulation; it does not publish a website or upload your data.

The standalone Node server uses the same interface and 3D bundle. Run `npm ci` once, then:

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
- A 3D felt tray with numbered d4/d8/d10/d12/d20 and pip-marked d6 dice, gravity, bounces and collisions. Three.js and cannon-es are bundled locally; no external CDN or model download is used.
- 3D faces land on the authorized server result. The animation never generates, replaces or shares dice results. Replay repeats the visual motion without submitting another roll. Each client can have a different cosmetic trajectory.
- Toggle 3D off at any time; reduced-motion preferences show the dice immediately. Devices without WebGL2 and other die sizes retain ordinary numeric results. Rendering stops when the window is hidden and GPU resources are released on sign-out.
- Dice expressions such as `1d20`, `3d20`, `2d6+4`, and `1d20-2`. Individual values and the total are retained; these are generic rolls, not automated DSA skill checks.
- Up to 20 dice per roll, 2–1000 sides, and modifiers from −10000 to +10000.
- **Public:** everyone in this campaign, including members who join later.
- **Only me:** just the account that rolled; even the GM is excluded.
- **To GM:** the account that rolled and the campaign's GM.
- The latest 100 authorized rolls are loaded on entry/reconnect. The database retains older rolls; there is no archive UI yet.
- The server generates dice with `crypto.randomInt`; clients cannot supply results, author identity, room identity, or roles.
- A draggable, resizable Hero Document window opens the existing RPG Projects Heldenbau editor and character vault. Attach a Heldenbau JSON export or PDF and choose its audience.
- Other hub elements are clearly marked **Coming later** and are not implemented yet.

Changing the visibility choice affects the **next** roll. A completed roll keeps its original audience.

## Character sheets

Open **Hero Document** from the hub. **Heldenbau · Create & edit** embeds the existing [RPG Projects DSA 4.1 generator](https://rpg-projects.vercel.app/projects/character-builder), including its own saved-hero library. An external-tab link is available if a browser blocks embedded login. RPG Projects keeps its own account and storage; The Tavern never receives that account's credentials.

To attach a hero to this table, export it in Heldenbau with **Als Datei**, then upload that JSON under **Character sheets**. The Tavern displays the base attributes and preserves every JSON field for download and re-import using Heldenbau's **Datei laden**. Full calculated sheets and editing remain in Heldenbau. These attachments are snapshots: changes in the generator do not automatically synchronize. Save generator work before signing out of The Tavern or reloading the page.

Alternatively, upload a PDF from **Drucken / PDF** or another character-sheet source. A self-hosted PDF.js viewer renders one page at a time with previous/next controls and a download fallback. It does not execute PDF scripts, embedded attachments or external links. Password-protected or unsupported PDFs can be downloaded for a local viewer.

Each account has **one current attachment**, up to **10 MiB for PDF** or **2 MiB for JSON**. Uploads default to **Only me**, which excludes even the GM. **To GM** includes the owner and campaign GM; **Public** includes this campaign's members. The available-sheets selector shows only authorized attachments; use Refresh to see another player's new attachment. Replacing requires the owner to acknowledge keeping a copy; replacement removes the previous attachment and its old download ID. There is no attachment history or automatic backup/export UI. Only the signed-in account can replace its own sheet; supplied owner IDs or roles are ignored.

Files are validated and stored in 64 KiB SQLite chunks in the existing campaign database, with atomic replacement. They are never public static files. Uploads are limited to five attempts per account per minute, including invalid files. No R2, AWS bucket, paid plan or third-party upload service is needed for this small group. For larger libraries, migrate file bytes to R2 or S3 while retaining these authorization checks.

## Storage and account boundaries

SQLite stores rooms, salted scrypt password hashes, hashed session tokens, rolls and character attachments. The standalone Node server uses `data/tavern.sqlite`. Cloudflare uses one SQLite-backed Durable Object per campaign, with a separate Durable Object for each IP's authentication rate limit. Session cookies are HttpOnly and SameSite=Strict and expire after seven days; HTTPS adds Secure. Signing out revokes the session and ends its open event connections. Accounts and history survive a runtime restart.

On Cloudflare, authenticated WebSockets deliver personalized updates. Connections can hibernate between events. Browser keepalive pings use Cloudflare's automatic response API, so they do not wake the campaign object; no server-side heartbeat interval runs. An alarm handles session expiry, and every broadcast checks the current stored session before sending a result.

The standalone database, local Wrangler state and deployed Cloudflare state are **separate datasets**. There is no automatic import/export tool yet. Existing `data/tavern.sqlite` is left untouched and is never uploaded by deployment.

Visibility is applied to both database queries and live delivery. Hidden results are not sent to unauthorized clients. **Only me** is an application-level privacy rule: the machine/database operator can still access stored records. Data is not end-to-end encrypted.

This first version has no password recovery, invitation rotation, member removal, account deletion, or GM transfer screen. Keep the invitation within the six-person group. Those administration features should precede wider public use. Cloudflare persists limits of 10 room-creation attempts and 30 join/sign-in attempts per minute per IP, and 60 rolls per minute per account. People sharing an internet connection share authentication limits. The standalone server has per-process rate limits.

Only the server should access `data/`; keep it out of source control and never put it in a public static directory. Back up SQLite using its backup API or stop the server before copying its database. Copying only a live `.sqlite` file can miss changes in the WAL.

## Verify

Run `npm ci` once. Build scripts generate ignored 3D/PDF client bundles and PDF.js support assets before starting or deploying the app. Geometry tests check every face/result orientation against its collision solid, including a physical playback with twenty d20 dice.

```sh
npm test
```

Run `npm ci` first. Tests first bundle the Cloudflare Worker using a deployment dry run, then exercise both backends. They use independent account cookies, real HTTP/SSE connections for Node, and the local Cloudflare runtime with WebSockets. They cover public delivery, private and GM-only exclusions, reconnect/history, room isolation, forged identities/roles, six-seat limits, authentication, origin validation, dice bounds, logout and persistence across restart. Cloudflare tests also force hibernation, check rate limits, and verify session expiry. Attachment tests check binary upload/download, all three audiences including GM exclusion, cross-campaign access, forged ownership, atomic replacement IDs, hibernation, upload limits and session revocation. They create isolated temporary data and do not touch your campaign database.

## Hosting

The selected path is **Cloudflare Workers with static assets and SQLite-backed Durable Objects**. One campaign object owns its accounts, history and live connections. There is no separate database subscription or always-on server to manage. See [the hosting and setup guide](docs/hosting.md).

The Cloudflare Free plan is the initial target, subject to its usage limits. A supplied `workers.dev` HTTPS address avoids buying a domain. R2 or AWS S3 can be added later for larger map and document libraries; neither is required or configured for the current dice and bounded character attachments.

The standalone fallback still needs one Node process and persistent disk with HTTPS for internet access. GitHub Pages cannot run either backend. The Worker and its two SQLite-backed Durable Object namespaces are deployed in the account pinned by `wrangler.jsonc`. No paid subscription, custom domain, AWS resources or Discord integration was added. GitHub Actions validates changes; publishing updates remains a separate Wrangler command.
