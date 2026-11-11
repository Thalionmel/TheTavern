# Hosting the first six-person table

Checked against the linked official sources on **11 November 2026**. Prices are the providers' listed USD prices, before any applicable tax. No service has been purchased or deployed.

The current app needs one long-running Node process, a small persistent disk for SQLite, and HTTPS or a trusted encrypted private network. There is no separate paid database or real-time messaging service to subscribe to.

| Approach | Cost | Fit for this version |
| --- | --- | --- |
| Local preview | No hosting subscription | Only reachable on the host computer by default. Useful for development and testing with different browser profiles. |
| Existing computer + Tailscale Personal | $0 for up to six personal users, plus your existing power/internet costs | Fits this group exactly. Everyone connects their device to the private network; the host computer must stay on. Configure an appropriate listening address and encrypted/private access before using real accounts. |
| Railway Hobby + persistent volume | $5 monthly minimum, including $5 of usage; usage beyond that costs extra | Convenient managed hosting. Attach persistent storage and point `DATABASE_PATH` into that volume. Confirm projected resource/volume usage in the dashboard before choosing a budget. |
| Render paid compute + persistent disk | Smallest paid compute is listed at $7/month; disk is $0.25/GB/month | Straightforward for this architecture. A 1 GB disk gives a starting listed base of $7.25/month, excluding additional usage/tax. |
| Render Free | $0 compute tier, with restrictions | Unsuitable for the current local SQLite design: the filesystem is ephemeral and free instances cannot attach a persistent disk. Data is lost on restart/redeploy/spin-down. |

Sources: [Tailscale pricing](https://tailscale.com/pricing), [Railway billing](https://docs.railway.com/pricing/understanding-your-bill), [Render pricing](https://render.com/pricing), [Render free-service restrictions](https://render.com/docs/free).

For an occasional game night, trying the existing-computer option first avoids a hosting bill. For a room that remains reachable between sessions without keeping a personal computer running, a small managed paid service is easier to operate. A domain is optional when using a provider's supplied HTTPS address; buying a custom domain is a separate choice.

GitHub hosts the source. GitHub Pages is static hosting and cannot run the account/dice backend. A free serverless alternative could be explored later, but this Node/SQLite app is not a drop-in deployment to a Workers/edge runtime.

Before an internet deployment, select the host and region, configure the exact HTTPS `APP_ORIGIN`, preserve `/api/events` streaming, choose persistent storage and a backup method, and test the three roll audiences on the real URL. No external service is needed for dice generation. Keep Discord voice/video outside the app for now.
