# Brick computers: internet, spending and cold storage

## The rule

Ordinary public internet access is **direct and open** (Agent37 `allow-all`; it never reaches private ranges, other machines or the host). Nothing
about it goes through a Universe proxy, and no paid infrastructure is needed to launch.

What a computer may SPEND is decided somewhere else, in Orbit:

- Universe-funded AI and Apps run through Orbit's broker and AI relay: job token, bot, payer, reservation, expiry, revocation. The platform's master
  credentials (Composio, AI providers) stay in Orbit; none is ever put on a computer.
- When Orbit is down, a paid action waits or fails. There is no fallback that hands a computer a provider key. Browsing is not affected.
- Agent37's own managed services (model router, Brave, Composio, Perflo) are reached with a token Agent37 injects into **every** instance. They stay
  shut by the instance **budget**, which has two parts: the monthly cap and the remaining one-time credit. A `$0` cap alone leaves credit usable. Orbit
  reads both back (`GET /v1/instances/{id}/budget`) when a machine is made, adopted, made ready and restored onto, sets a non-zero cap back to zero
  (`PATCH /v1/instances/{id}/budget`), and refuses to hand over a machine that still holds credit (Agent37 has no call that lowers it; the credit is
  never "spent down"). Readiness shows the same check for up to 30 machines.
  Agent37's docs say the injected token cannot change budgets (the workspace key does); that is a provider statement, listed below to be tested.

## Done by hand, once (a provider dashboard setting; Orbit cannot read it)

- **Composio**: restrict the runtime project key to Orbit's real **outbound** IPv4/IPv6 addresses (the addresses Composio sees for API calls, not the
  website's inbound address) and to the least-privilege scope that works. Test REST, sessions and MCP. Never copy a production key for the test.
- Other providers: apply source or spending restrictions where they offer them (for example an OpenRouter per-key limit), and note where they do not.

## Qualification (one throwaway Agent37 computer; nothing here has been run against a real machine yet)

1. Direct internet works as the product needs: browser, downloads, package install, Git/SSH, WebSocket, and any UDP/WebRTC use.
2. Private, link-local and metadata ranges are not reachable (provider-approved test; do not read real metadata secrets).
3. Budget: monthly cap and remaining one-time credit are zero; the injected token cannot change them; paid managed calls do not debit the wallet.
4. Lifecycle: create, adopt, reboot, restore, image update and drift keep the network rule and the zero budget.
5. A restored computer carries no old authority: job key dropped, no stale proxy settings (`universe-cold finish` removes them).
6. Cold storage: real archive size, restore time, whether the archive download is charged, and whether a deleted instance can be recovered for 7 days or 1 hour.

## A design that was dropped

A general egress proxy (two gateway servers, every computer's traffic through them) was built and then dropped before launch: it needed paid
servers, blocked UDP/QUIC/ICMP and programs that ignore proxy settings, and a gateway outage meant no internet. Its code is not in this repository;
a separate proposal can bring it back if a real need appears.
