# letta-mcp-channel

A generic [Model Context Protocol](https://modelcontextprotocol.io/) channel plugin for [Letta Code](https://github.com/letta-ai/letta-code).

Connects to any MCP server over **Streamable HTTP**, calls `resources/subscribe` on configured resources, and delivers each `notifications/resources/updated` event to the agent as an inbound message. The channel is **read-only and domain-agnostic** — no email-, calendar-, or chat-specific code paths. If a server speaks MCP resources, this plugin handles it.

The agent replies by calling MCP tools through Letta's existing MCP tool integration. See [Outbound replies](#outbound-replies).

**Status:** proof of concept. Requires Letta Code with dynamic channel plugin support ([PR #2021](https://github.com/letta-ai/letta-code/pull/2021), shipped in 0.25.x).

---

## Why this exists

Letta Code agents already use MCP for **tool calling** (via `.mcp.json` — see [docs.letta.com/guides/core-concepts/tools/mcp-tools](https://docs.letta.com/guides/core-concepts/tools/mcp-tools)). But MCP also defines a **push** mechanism — `resources/subscribe` + `notifications/resources/updated` — for "tell me when this resource changes." No Letta channel exposes that today.

This plugin closes the gap. The shape: subscribe the agent to a resource on any MCP server, deliver each update as a message, let the agent react by calling tools on the same (or any other) configured MCP server. Concretely, that could be a filesystem server pushing `notifications/resources/updated` when a watched directory changes, a CI server pushing build-status resources, or — hypothetically, if such a server existed — an email server exposing `inbox` as a resource and `send_email` as a tool.

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

Expected (URL reflects whatever you put in `config.url`):

```
[MCP] Connecting to <your config.url>
[MCP] Connected; subscribed to N resource(s)
```

For a concrete worked example with full output, see the [demo](#end-to-end-demo-with-the-everything-server) below.

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

### A note on the approval gate

When the agent reacts to a channel message it calls Letta's built-in `MessageChannel` tool to dispatch the reply. `MessageChannel` is a **client-side tool**, not a server-registered one — it's injected into the agent loop by `letta server` at runtime when channels are active. That has two consequences worth knowing:

1. **You cannot disable approval through the `/v1/tools/.../approval` API.** That endpoint only manages server-registered tools; for client-side tools it returns 404. (Common mistake — earlier drafts of this README recommended a `PATCH` call there. It doesn't work.)
2. **In headless mode (`letta server --channels mcp`) the device runs with `current_permission_mode: "unrestricted"` by default**, which auto-handles approval requests for client-side tools. So you don't need to do anything — the `MessageChannel` call fires through and the plugin logs the dispatch.

If you instead run the agent inside the interactive Letta Code TUI, each `MessageChannel` call will pop up a HITL approval prompt. Approve it manually, or change the device's permission mode. See the [HITL docs](https://docs.letta.com/guides/core-concepts/tools/human-in-the-loop/) for the full surface.

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

In headless mode the device auto-handles the approval gate (see [the approval-gate note above](#a-note-on-the-approval-gate)) and the agent's `MessageChannel.send` call dispatches through to the plugin, which logs it:

```
[MCP] MessageChannel.send acknowledged (chatId=architecture): <whatever the agent wrote back>
```

The handler then returns `Acknowledged — the mcp channel is read-only…` to the agent, reminding it that to actually take action it needs to call a real MCP tool through its native MCP integration (see [Outbound replies](#outbound-replies)).

Every 5 seconds the everything server fires a fresh `notifications/resources/updated`. The plugin re-reads the resource body each time and **deduplicates by content** — if the body hasn't actually changed since the last delivery, the update is dropped on the floor rather than spammed to the agent:

```
[MCP] Resource updated: demo://resource/static/document/architecture.md
[MCP] Resource unchanged, skipping: demo://resource/static/document/architecture.md
[MCP] Resource unchanged, skipping: demo://resource/static/document/architecture.md
...
```

This matters because most MCP servers (the everything server included) push periodic "heads-up, still here" pings that aren't tied to real change events. Without dedup the agent's context window burns down very quickly. See [`rules.json`](#rulesjson) → `fetch_on_update` if you'd rather forward every notification regardless.

### What you've just verified

The plugin **connected** to a real MCP server, **subscribed** to a resource, **received** `notifications/resources/updated`, **fetched** the resource body via `resources/read`, **delivered** the update through `adapter.onMessage`, and Letta **routed** it to a real agent that reasoned about the payload and **decided to reply via the channel** — all generically, with no email-, document-, or server-specific code.

To verify the **reply path**, add the same server to the agent's `.mcp.json` (see [Outbound replies](#outbound-replies)) so the agent can call the everything server's `echo` (or any) tool. The agent will see the "channel is read-only" return value from `MessageChannel.send` and reach back to the same MCP server via its native MCP tool integration — completing the loop the plugin was designed for.

---

## Outbound replies

The channel is **inbound only**. To let the agent react to an update — send an email, post a calendar event, mark a notification as read — add the **same MCP server** to the agent's `.mcp.json` so its tools are discoverable through Letta's native MCP tool integration:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "<same URL as config.url in accounts.json>"
    }
  }
}
```

See [docs.letta.com/guides/core-concepts/tools/mcp-tools](https://docs.letta.com/guides/core-concepts/tools/mcp-tools).

When an update arrives, the agent receives an inbound message describing the change. It then calls any tool the server exposes to respond — no channel-specific glue required. The plugin's `MessageChannel.send` action is wired up so dispatch doesn't error, but it does **not** post anything back to the MCP server: there's no semantically correct way to "post a message back" through `resources/subscribe`. It just acknowledges the agent's intent and returns a string nudging the agent to use a real MCP tool through its native integration — tool calls are the right channel for outbound action.

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

#### Content-based deduplication

When `fetch_on_update` is `true` (the default), the plugin keeps the last delivered body for each subscribed URI in memory and **skips delivery if the new body is byte-for-byte identical** to the previous one. This trades a tiny amount of memory (last body per URI, post-truncation) for protection against notification floods.

Why this is necessary: many MCP servers — the everything server included — fire `notifications/resources/updated` on a fixed timer rather than on actual resource mutation. Without dedup the agent's context window gets flooded with identical notifications every few seconds. With dedup, the agent only wakes up when the resource has genuinely changed.

When a duplicate is dropped you'll see:

```
[MCP] Resource unchanged, skipping: <uri>
```

If you set `fetch_on_update: false`, the plugin doesn't read the body, can't dedup, and forwards every notification verbatim. That's the right mode for high-fidelity notification streams where every event matters even if the URI's "current state" is unchanged (think: webhook-style events).

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

### Outbound calls are no-ops

This is a notification channel, not a chat channel. There are three outbound surfaces; all three log+drop:

- `sendMessage` (legacy adapter path) — logs and returns a placeholder messageId.
- `sendDirectReply` (Letta system messages: pairing notices, "not connected" warnings) — logs and drops silently. There is no human DM to reply to.
- `messageActions.handleAction({ action: 'send' })` (the agent's `MessageChannel.send` tool) — logs the dispatch, does **not** call the MCP server, and returns a string telling the agent the channel is read-only so it should use a real MCP tool instead.

The agent reaches the server through native MCP tools — see [Outbound replies](#outbound-replies).

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
