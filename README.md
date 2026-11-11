# The Tavern

A shared tabletop campaign hub for one game master and five players. The first working slice is **accounts, campaign rooms, and live dice rolls with server-enforced visibility**.

## Run locally

Requires **Node.js 22.14 or newer**. No npm packages or build step are needed.

```sh
npm start
```

Open <http://127.0.0.1:3000>. Create a room to become its GM, then copy the invitation link. Friends join with their own names and passwords. Existing members use **Sign in**, with the same room code and account details.

Use separate browser profiles, different browsers, or a private browser window to test two accounts on one computer. Tabs in the same browser profile share their signed-in account. Two accounts must connect to **the same server** to share rolls; running separate app copies creates separate tables.

The initial server listens only on `127.0.0.1`. This is a local preview, not a public website. If explicitly setting up a trusted LAN test, set `HOST=0.0.0.0` and use the host computer's LAN address on both devices. Use an HTTPS origin or an encrypted private network before sending real account passwords remotely.

Optional configuration: copy `.env.example` to `.env`. `HOST`, `PORT`, `DATABASE_PATH`, and `APP_ORIGIN` are supported. Configure `APP_ORIGIN` to the exact public HTTPS origin when using a reverse proxy. A configured HTTPS origin enables Secure session cookies and HSTS. The proxy must preserve streaming responses; `/api/events` is an authenticated server-sent event connection.

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

SQLite stores rooms, salted scrypt password hashes, hashed session tokens, and rolls at `data/tavern.sqlite`. Session cookies are HttpOnly and SameSite=Strict and expire after seven days. Signing out revokes the session and ends its open event connections. Accounts and history survive a server restart.

Visibility is applied to both database queries and live delivery. Hidden results are not sent to unauthorized clients. **Only me** is an application-level privacy rule: the machine/database operator can still access stored records. Data is not end-to-end encrypted.

This first version has no password recovery, invitation rotation, member removal, account deletion, or GM transfer screen. Keep the invitation within the six-person group. Those administration features should precede wider public use. Basic per-process rate limits are included; behind a proxy all clients may share an IP-based authentication limit.

Only the server should access `data/`; keep it out of source control and never put it in a public static directory. Back up SQLite using its backup API or stop the server before copying its database. Copying only a live `.sqlite` file can miss changes in the WAL.

## Verify

```sh
npm test
```

The tests use independent account cookies and real HTTP/SSE connections. They cover public delivery, private and GM-only exclusions, reconnect/history, room isolation, forged identities/roles, six-seat limits, authentication, origin validation, dice bounds, logout and persistence across restart.

## Hosting

This version needs **one long-running Node process and persistent disk storage**, with HTTPS for internet access. SQLite is intentionally simple for one six-person group. Run one app instance; distributing multiple instances would require shared storage and a shared live-event broker.

Static hosting such as GitHub Pages cannot run this backend. An ephemeral filesystem will lose campaign data when the service restarts. A small server or a managed Node service with an attached persistent volume fits the current design. A domain is optional if the host supplies a usable HTTPS address.

No cloud resources, subscriptions, public deployments, or Discord integrations are configured by this repository.
