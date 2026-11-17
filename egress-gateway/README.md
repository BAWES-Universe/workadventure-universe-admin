# Egress gateway

The way out of a Brick computer, and it is the open internet. The computer's Agent37 network rule is an allow list of this gateway's address and
nothing else; its tools reach the internet through a small forwarder on the computer that adds the computer's own key. The gateway lets the whole
public internet through: any port, names and raw addresses, plain and encrypted, WebSocket and other upgrades, and traffic that is not HTTP at all.

It refuses only what is already agreed, and nothing else:

- Composio, Agent37's own API and the dashboards of providers, and the Universe AI provider hosts (so the metered services are not bypassed). A name is
  judged by the name asked for, by the name in the TLS hello and by the HTTP Host.
- Private, loopback, link-local, metadata and other internal addresses, whether typed or what a name resolves to (so a computer cannot reach Orbit's
  network or a cloud's metadata service).

Design and price: **proposed, pending verification until measured on a real Agent37 instance.** Nothing here has been run against a real machine yet.

## Run it

Build with the repository root as context (`docker build -f egress-gateway/Dockerfile .`). It listens on one port (3128 by default).

| Setting | What |
| --- | --- |
| `EGRESS_GATEWAY_SECRET` | The same value Orbit holds (24+ characters). Keys for computers are signed with it. Required. |
| `ORBIT_URL` | Orbit's address. The gateway asks `GET /api/egress/deny` (bearer = the secret) every 5 minutes for the Universe AI provider hosts to refuse. |
| `EGRESS_PORT` | Port to listen on (default 3128). |
| `EGRESS_ALLOWED_PORTS` | Optional. Unset means every port is open. A comma list narrows it; leave it unset for a fully featured computer. |
| `EGRESS_DENY_HOSTS`, `EGRESS_DENY_CIDRS` | Extra names / ranges to refuse. |

Agent37 lets an IPv4 entry through on any port but a name on 443 only, so give the gateway a public IPv4 address (or put it behind a name on 443).
Deploy two, on different hosts: a computer's forwarder tries the next one when one does not answer. When none answers the forwarder says 502 and
sends nothing: a gateway outage never opens a direct route.

Then in Orbit set `EGRESS_GATEWAYS` (comma list of `address:port`) and `EGRESS_GATEWAY_SECRET`. Without both, no computer is made or made ready
(it fails closed).

`/__egress/health` answers without a key: `{ ok, open, connections, refused, bytesToInternet, bytesFromInternet, startedAt }`. Read it before and
after the qualification run below to measure transfer volume.

## What the proxy cannot carry

A proxy carries TCP (HTTP, HTTPS, WebSocket, SSH, databases) for programs that use proxy settings (the forwarder, and the environment, apt and git
settings written on the machine). It does not carry UDP or QUIC, ICMP, or a program that ignores proxy settings: Agent37's allow list admits only
the gateway addresses, so these have no route (and cannot get around the gateway either). The alternative, `allow-all`, would let the metered
services be bypassed, so it is not used. If real use shows a need, the follow-up is a transparent TCP redirect on the machine, not a wider rule.
Encrypted names that hide behind another name (domain fronting, ECH) cannot be seen; the protection that counts is that the machine holds no
provider keys.

## Qualification run (one throwaway Agent37 computer, costs cents; to be done before the design is called verified)

1. Say which Agent37 product the machines run on (Cloud API or dashboard-hosted) and whether a deleted instance can be recovered, and for how long
   (7 days or 1 hour).
2. Create the computer with the allow list of the gateways only. Confirm the entry format and that an IPv4 entry (stored as /32) lets any port through.
3. `universe-egress check` on it: gateway answers with the computer's key; direct connection to 1.1.1.1 and IPv6 are blocked; direct UDP DNS gets no
   answer.
4. From the machine: HTTPS to a public site, a WebSocket, an SSH connection and a raw-address request through the proxy all work; `composio.dev`, a
   Universe AI host and `169.254.169.254` are refused.
5. Stop both gateways: the machine's requests fail and nothing goes out directly. Start one: traffic goes on through it.
6. Read `/__egress/health` before and after to measure transfer volume, and note latency and the monthly cost per gateway.
7. Cold storage: pack the computer away, restore it on a throwaway computer, and note the real archive size, the time to restore, and whether the
   archive download is charged.
