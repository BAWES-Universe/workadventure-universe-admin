# Egress gateway

The only way out of a Brick computer. Its Agent37 network rule is an allow list of this gateway's address and nothing else; its tools reach the web
through a small forwarder on the computer that adds the computer's own key. The gateway lets the public web through and refuses Composio and Universe AI
names (by the name asked for and by the name in the TLS hello), raw addresses with no name, and private, metadata and internal addresses.

## Run it

Build with the repository root as context (`docker build -f egress-gateway/Dockerfile .`). It listens on one port (3128 by default).

| Setting | What |
| --- | --- |
| `EGRESS_GATEWAY_SECRET` | The same value Orbit holds (24+ characters). Keys for computers are signed with it. Required. |
| `ORBIT_URL` | Orbit's address. The gateway asks `GET /api/egress/deny` (bearer = the secret) every 5 minutes for the Universe AI provider hosts to refuse. |
| `EGRESS_PORT` | Port to listen on (default 3128). |
| `EGRESS_ALLOWED_PORTS` | Ports a computer may reach (default 22, 80, 443, 8080, 8443, 9418). |
| `EGRESS_DENY_HOSTS`, `EGRESS_DENY_CIDRS` | Extra names / ranges to refuse. |

Agent37 lets an IPv4 entry through on any port but a name on 443 only, so give the gateway a public IPv4 address (or put it behind a name on 443).
Deploy two, on different hosts: a computer's forwarder tries the next one when one does not answer.

Then in Orbit set `EGRESS_GATEWAYS` (comma list of `address:port`) and `EGRESS_GATEWAY_SECRET`. `/__egress/health` answers without a key for a check.
