# letta-mcp-channel

A generic [Model Context Protocol](https://modelcontextprotocol.io/) channel plugin for [Letta Code](https://github.com/letta-ai/letta-code).

Connects to any MCP server over **Streamable HTTP**, calls `resources/subscribe` on configured resources, and delivers each `notifications/resources/updated` event to the agent as an inbound message. The channel is **read-only and domain-agnostic** — no email-, calendar-, or chat-specific code paths. If a server speaks MCP resources, this plugin handles it.

The agent replies by calling MCP tools through Letta's existing MCP tool integration. See [Outbound replies](#outbound-replies).

**Status:** proof of concept. Requires Letta Code with dynamic channel plugin support ([PR #2021](https://github.com/letta-ai/letta-code/pull/2021), shipped in 0.25.x).

---

## Why this exists

Letta Code agents already use MCP for **tool calling** (via `.mcp.json` — see [docs.letta.com/guides/core-concepts/tools/mcp-tools](https://docs.letta.com/guides/core-concepts/tools/mcp-tools)). But MCP also defines a **push** mechanism — `resources/subscribe` + `notifications/resources/updated` — for "tell me when this resource changes." No Letta channel exposes that today.

This plugin closes the gap. Subscribe an agent to an inbox resource on an email MCP server, the agent gets notified when mail arrives and can call the same server's `send_email` tool to reply. Same shape for filesystem changes, CI run status, calendar events, sensor readings — anything an MCP server can model as a subscribable resource.

---

## Installation

### 1. Copy files into Letta's channel directory

```bash
git clone https://github.com/vezzadev/letta-mcp-channel.git
mkdir -p ~/.letta/channels/mcp
cp letta-mcp-channel/{channel.json,plugin.mjs,rules.json,accounts.json.example} ~/.letta/channels/mcp/
```

> The runtime directory **must** be named `mcp` — it has to match the `id` in `channel.json`. Don't copy it as `letta-mcp-channel/`.

### 2. Install the SDK runtime

```bash
letta channels install mcp
```

Installs `@modelcontextprotocol/sdk` into `~/.letta/channels/mcp/runtime/node_modules/`. Expected output:

```json
{
  "success": true,
  "channel": "mcp",
  "installed": true,
  "runtimeDir": "/home/<you>/.letta/channels/mcp/runtime"
}
```

### 3. Configure your MCP server

```bash
cp ~/.letta/channels/mcp/accounts.json.example ~/.letta/channels/mcp/accounts.json
$EDITOR ~/.letta/channels/mcp/accounts.json
```

Fill in `config.url` (the MCP Streamable HTTP endpoint), optional `config.headers` (auth, etc.), and your `config.subscriptions` list:

```json
"subscriptions": [
  { "uri": "<server-specific-uri>", "chatId": "inbox" }
]
```

Each `uri` is server-defined — there's no standard registry of MCP resource URIs. Real examples from existing servers: `file:///path/to/file.txt`, `git://repo/branch`, `demo://resource/static/document/architecture.md` (the everything server, see the [demo section](#end-to-end-demo-with-the-everything-server) below). To discover what a given server exposes, either:

- check the server's docs
- call `resources/list` from any MCP client (e.g. `npx @modelcontextprotocol/inspector <url>`)
- **or just omit `subscriptions`** — the plugin will call `resources/list` itself and subscribe to everything, routing all updates to the `default_chat_id` from `rules.json`

The earlier `email://inbox` motivation in the intro is hypothetical — there is no canonical "email MCP server" yet, just the *shape* an email server would take if one existed.

### 4. Get your agent ID

```bash
letta agents list | jq -r '.body[].id'
```

### 5. Add a route per `chatId`

> Do **not** use `letta channels configure mcp` — that wizard only handles first-party channels (telegram, slack, discord). Custom plugins are configured via `accounts.json` and `route add`.

```bash
letta channels route add \
  --channel mcp \
  --chat-id inbox \
  --agent <YOUR_AGENT_ID> \
  --conversation default
```

The `chat-id` is the alias from `subscriptions[].chatId` (not the resource URI). One route per chatId.

### 6. Start the server

```bash
export LETTA_API_KEY=sk-let-...
letta server --channels mcp --debug
```

Expected:

```
[MCP] Connecting to https://mcp.example.com/email
[MCP] Connected; subscribed to 1 resource(s)
```

---

## End-to-end demo with the everything server

A self-contained 5-minute demo using [`@modelcontextprotocol/server-everything`](https://www.npmjs.com/package/@modelcontextprotocol/server-everything), the reference MCP server that exposes subscribable resources and a `toggle-subscriber-updates` tool that emits updates on a 5-second timer.

### Setup

Terminal 1 — start the reference MCP server:

```bash
npx -y @modelcontextprotocol/server-everything streamableHttp
```

Expected:

```
Starting Streamable HTTP server...
MCP Streamable HTTP Server listening on port 3001
```

Terminal 2 — deploy the plugin and install the SDK:

```bash
mkdir -p ~/.letta/channels/mcp
cp channel.json plugin.mjs rules.json accounts.json.example ~/.letta/channels/mcp/
letta channels install mcp
```

Write `~/.letta/channels/mcp/accounts.json` pointing at the local everything server. The `bootstrap_tools` entry is what makes the everything server start its periodic update timer **on the plugin's MCP session** (the server scopes its update timer per-session, so we need to fire `toggle-subscriber-updates` from inside the plugin's session — see [Bootstrap tools](#bootstrap-tools)):

```json
{
  "accounts": [
    {
      "channel": "mcp",
      "accountId": "everything-demo",
      "displayName": "everything server (demo)",
      "enabled": true,
      "dmPolicy": "open",
      "allowedUsers": [],
      "config": {
        "url": "http://localhost:3001/mcp",
        "subscriptions": [
          { "uri": "demo://resource/static/document/architecture.md", "chatId": "architecture" }
        ],
        "bootstrap_tools": [
          { "name": "toggle-subscriber-updates", "arguments": {} }
        ]
      },
      "createdAt": "2026-05-20T00:00:00.000Z",
      "updatedAt": "2026-05-20T00:00:00.000Z"
    }
  ]
}
```

Add a route to your agent:

```bash
export LETTA_API_KEY=sk-let-...
AGENT=$(letta agents list | jq -r '.body[0].id')
letta channels route add --channel mcp --chat-id architecture --agent "$AGENT" --conversation default
```

### Run

Terminal 2 — start Letta:

```bash
letta server --channels mcp --debug
```

### Expected output

You should see this within seconds of startup (plugin lines are interleaved with Letta's WebSocket protocol traffic in `--debug`):

```
[MCP] Connecting to http://localhost:3001/mcp
[MCP] Connected; subscribed to 1 resource(s)
[MCP] bootstrap toggle-subscriber-updates: Started simulated resource updated notifications for session <uuid> at a 5 second pace.
[MCP] Resource updated: demo://resource/static/document/architecture.md
[<ts>] → send (protocol)  {"type":"update_queue","queue":[{...,"source":"channel",...}], ...}
```

Letta then forwards the update to the agent and you'll see a reasoning stream resembling:

> The user received an MCP resource update notification for an architecture document. This is a channel notification from the MCP channel. I need to respond via MessageChannel. … Let me acknowledge this briefly and naturally.

Followed by an `approval_request_message` for the `MessageChannel` tool call — Letta's default interactive-mode gate. Approve or deny in the Letta Code app/CLI.

Every 5 seconds, a fresh update fires:

```
[MCP] Resource updated: demo://resource/static/document/architecture.md
[MCP] Resource updated: demo://resource/static/document/architecture.md
[MCP] Resource updated: demo://resource/static/document/architecture.md
...
```

### What you've just verified

The plugin **connected** to a real MCP server, **subscribed** to a resource, **received** `notifications/resources/updated`, **fetched** the resource body via `resources/read`, **delivered** the update through `adapter.onMessage`, and Letta **routed** it to a real agent that reasoned about the payload and **decided to reply via the channel** — all generically, with no email-, document-, or server-specific code.

To verify the **reply path**, add the same server to the agent's `.mcp.json` (see [Outbound replies](#outbound-replies)) so the agent can call the everything server's `echo` (or any) tool. With the plugin's `MessageChannel` suppressed, you'll see the agent reach back to the same MCP server via its native MCP tool integration — completing the loop the plugin was designed for.

---

## Outbound replies

The channel is **inbound only**. To let the agent react to an update — send an email, post a calendar event, mark a notification as read — add the **same MCP server** to the agent's `.mcp.json` so its tools are discoverable through Letta's native MCP tool integration:

```json
{
  "mcpServers": {
    "email": {
      "type": "http",
      "url": "https://mcp.example.com/email"
    }
  }
}
```

See [docs.letta.com/guides/core-concepts/tools/mcp-tools](https://docs.letta.com/guides/core-concepts/tools/mcp-tools).

When an update arrives, the agent receives an inbound message describing the change. It then calls any tool the server exposes (e.g. `send_email`, `mark_read`) to respond — no channel-specific glue required. The plugin's `MessageChannel.send` is suppressed because there's no semantically correct way to "post a message back" through `resources/subscribe`; tool calls are the right channel for outbound action.

---

## Architecture

```
MCP server (Streamable HTTP)
    │
    │  resources/list, resources/subscribe (on connect)
    ▼
mcp-channel adapter ◀── notifications/resources/updated
    │
    │  (optional) resources/read
    ▼
adapter.onMessage({ chatId, text: <update + body>, raw: {uri, content} })
    │
    ▼
Letta routes by chatId → agent conversation
    │
    │  agent reacts
    ▼
agent calls MCP tool (Letta's native MCP integration, via .mcp.json)
    │
    ▼
MCP server (same one)
```

---

## Configuration

### accounts.json

Follows the standard Letta `ChannelAccount` envelope. Plugin-specific config lives under `config`:

| Field | Required | Description |
|-------|----------|-------------|
| `config.url` | yes | MCP Streamable HTTP endpoint |
| `config.headers` | no | Extra request headers (auth, tracing, etc.). Merged into every request. |
| `config.subscriptions` | no | List of `{uri, chatId}`. Routes each subscribed resource to a named chatId. If omitted, falls back to auto-subscribe via `resources/list` with `rules.default_chat_id`. |
| `config.bootstrap_tools` | no | List of `{name, arguments}` tool calls to invoke right after the initial subscribe. See [Bootstrap tools](#bootstrap-tools). |

`dmPolicy` should be `"open"` — see [DM policy](#dm-policy).

### rules.json

Re-read on every notification, so edits take effect without restarting.

| Field | Default | Description |
|-------|---------|-------------|
| `fetch_on_update` | `true` | Call `resources/read` on every update and embed the content in the inbound message. Set to `false` for URI-only notifications. |
| `default_chat_id` | `"updates"` | chatId used when subscriptions are auto-derived from `resources/list`. |
| `reconnect_initial_ms` | `1000` | Initial backoff after a transport drop. |
| `reconnect_max_ms` | `60000` | Cap on the exponential backoff. |
| `max_resource_chars` | `4000` | Truncate fetched resource bodies before embedding. |

---

## Bootstrap tools

Some MCP servers need an init / handshake tool call before they'll push notifications — auth handshakes, "enable streaming" toggles, session-scoped subscription managers. `config.bootstrap_tools` is a generic escape hatch for those: a list of `{name, arguments}` calls that run on the plugin's own MCP session right after the initial `subscribe` round-trip.

Example (used in the demo above):

```json
"bootstrap_tools": [
  { "name": "toggle-subscriber-updates", "arguments": {} }
]
```

The everything server scopes its periodic update timer per session, so to receive updates on the plugin's session you need to fire the toggle from inside that session. Most real-world MCP servers won't need this — they push autonomously.

Failures are logged but non-fatal; the subscription stays live.

---

## DM policy

This channel must use `dmPolicy: "open"`. DM policy is Letta's accept-gate **before** `routing.yaml` lookup:

- `pairing` triggers a one-time-code handshake on first message from an unknown sender (human DM flow).
- `allowlist` filters by sender ID against `allowedUsers`.
- `open` accepts every message the adapter emits and defers to `routing.yaml` for delivery.

The MCP server pushes resource updates — there's no human sender to allowlist and no pairing to complete. `open` is the only policy that fits. Delivery is then gated by whether you ran `letta channels route add --chat-id <id>` for that resource's chatId alias.

---

## Known gotchas

### routing.yaml is actually JSON

Letta names the routing file `routing.yaml` but parses it with `JSON.parse`. If you edit it by hand, write JSON.

### Edit files in the right place

All runtime files (`accounts.json`, `rules.json`) are read from `PLUGIN_DIR` — the directory containing `plugin.mjs` — which is `~/.letta/channels/mcp/` at runtime. If your agent's edit tool creates files at an unexpected path, you may end up with a phantom directory that looks correct but isn't connected to the running plugin. When in doubt: `ls ~/.letta/channels/` and confirm only `mcp/` exists.

### sendMessage / sendDirectReply are suppressed

This is a notification channel, not a chat channel. If Letta tries to send anything outbound through the adapter (pairing notices, "not connected" system messages, agent replies posted via `MessageChannel`), the plugin logs and drops them rather than calling back into the MCP server. The agent reaches the server through native MCP tools instead — see [Outbound replies](#outbound-replies).

### rules.json takes effect immediately

Every notification re-reads `rules.json`. Changes to `fetch_on_update`, `max_resource_chars`, `default_chat_id`, and reconnect bounds land on the next event, no restart needed.

### Route changes need a restart

`accounts.json` and `routing.yaml` edits are picked up at startup. After `letta channels route add`, restart `letta server` (or use the live `/channels mcp enable` WebSocket command).

### Streamable HTTP only

stdio and SSE are not implemented. Only remote MCP servers reachable at an HTTP URL are supported.

---

## Spec references

- Custom channel plugin contract: [`letta-ai/letta-code` → `src/channels/README.md`](https://github.com/letta-ai/letta-code/blob/main/src/channels/README.md)
- User-facing channels docs: [docs.letta.com/letta-code/channels](https://docs.letta.com/letta-code/channels/)
- MCP spec: [modelcontextprotocol.io](https://modelcontextprotocol.io/)
- MCP JavaScript SDK: [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)

---

## License

MIT.
