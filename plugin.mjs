/**
 * Generic MCP channel plugin for Letta Code.
 *
 * Connects to a remote MCP server over Streamable HTTP, subscribes to
 * configured resources, and delivers `notifications/resources/updated`
 * events to the agent as inbound messages. The channel is read-only:
 * outbound replies happen through Letta's native MCP tool integration
 * (configure the same server in the agent's .mcp.json).
 *
 * All runtime files live next to plugin.mjs (PLUGIN_DIR):
 *   rules.json    — runtime knobs; re-read on every notification, no restart needed
 *   accounts.json — { url, headers, subscriptions } under each account's `config`
 *
 * Requires Letta Code with dynamic channel plugin support (PR #2021).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(PLUGIN_DIR, 'rules.json');

const DEFAULT_RULES = {
  /** Read the resource body and embed it in the inbound message. */
  fetch_on_update: true,
  /** chatId used when subscriptions are auto-derived from resources/list. */
  default_chat_id: 'updates',
  /** Initial reconnect backoff (ms). Doubles per attempt, capped at reconnect_max_ms. */
  reconnect_initial_ms: 1000,
  reconnect_max_ms: 60_000,
  /** Truncate fetched resource bodies before embedding them in the message. */
  max_resource_chars: 4000,
};

function loadRules() {
  try {
    if (existsSync(RULES_PATH)) {
      return { ...DEFAULT_RULES, ...JSON.parse(readFileSync(RULES_PATH, 'utf-8')) };
    }
  } catch (e) {
    console.error('[MCP] Failed to load rules:', e.message);
  }
  return { ...DEFAULT_RULES };
}

function formatUpdateMessage(uri, content) {
  const body = content ? content : '(content not fetched)';
  return `🔔 MCP resource updated — ${uri}\n\n${body}`;
}

export const channelPlugin = {
  metadata: {
    id: 'mcp',
    displayName: 'MCP',
    runtimePackages: ['@modelcontextprotocol/sdk@^1.29.0'],
    runtimeModules: ['@modelcontextprotocol/sdk'],
  },

  async createAdapter(account) {
    const config = account.config ?? {};
    if (!config.url) {
      throw new Error('[MCP] account.config.url is required');
    }

    let client = null;
    let transport = null;
    let uriToChatId = new Map();
    let lastContentByUri = new Map();
    let autoMode = false;
    let running = false;
    let reconnectTimer = null;
    let reconnectDelay = DEFAULT_RULES.reconnect_initial_ms;

    async function deriveSubscriptions() {
      uriToChatId = new Map();
      if (Array.isArray(config.subscriptions) && config.subscriptions.length > 0) {
        autoMode = false;
        for (const sub of config.subscriptions) {
          if (sub?.uri && sub?.chatId) uriToChatId.set(sub.uri, sub.chatId);
        }
        return;
      }
      autoMode = true;
      const rules = loadRules();
      const { resources = [] } = await client.listResources();
      for (const r of resources) {
        if (r?.uri) uriToChatId.set(r.uri, rules.default_chat_id);
      }
    }

    async function handleUpdate(uri) {
      const chatId = uriToChatId.get(uri);
      if (!chatId) {
        console.log(`[MCP] Update for unsubscribed uri ignored: ${uri}`);
        return;
      }

      const rules = loadRules();
      let content = null;
      if (rules.fetch_on_update) {
        try {
          const result = await client.readResource({ uri });
          const parts = (result?.contents ?? [])
            .map(c => (typeof c.text === 'string' ? c.text : ''))
            .filter(Boolean);
          content = parts.join('\n').slice(0, rules.max_resource_chars);
        } catch (e) {
          console.error(`[MCP] readResource(${uri}) failed:`, e.message);
        }
      }

      // Deduplicate: skip notification if content hasn't changed
      const prev = lastContentByUri.get(uri);
      if (prev !== undefined && prev === content) {
        console.log(`[MCP] Resource unchanged, skipping: ${uri}`);
        return;
      }
      lastContentByUri.set(uri, content);

      console.log(`[MCP] Resource updated: ${uri}`);

      if (!adapter.onMessage) return;
      try {
        await adapter.onMessage({
          channel: 'mcp',
          accountId: account.accountId,
          chatId,
          chatType: 'channel',
          senderId: `mcp:${uri}`,
          senderName: uri,
          text: formatUpdateMessage(uri, content),
          timestamp: Date.now(),
          messageId: `${uri}@${Date.now()}`,
          raw: { uri, content },
        });
      } catch (e) {
        console.error('[MCP] Failed to deliver update:', e.message);
      }
    }

    async function handleListChanged() {
      if (!autoMode) return;
      try {
        const rules = loadRules();
        const { resources = [] } = await client.listResources();
        for (const r of resources) {
          if (r?.uri && !uriToChatId.has(r.uri)) {
            uriToChatId.set(r.uri, rules.default_chat_id);
            await client.subscribeResource({ uri: r.uri });
            console.log(`[MCP] Subscribed to new resource: ${r.uri}`);
          }
        }
      } catch (e) {
        console.error('[MCP] list_changed handling failed:', e.message);
      }
    }

    function scheduleReconnect() {
      if (!running) return;
      if (reconnectTimer) return;
      const delay = reconnectDelay;
      console.log(`[MCP] Reconnecting in ${delay}ms`);
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try {
          await connect();
        } catch (e) {
          console.error('[MCP] Reconnect failed:', e.message);
          const rules = loadRules();
          reconnectDelay = Math.min(reconnectDelay * 2, rules.reconnect_max_ms);
          scheduleReconnect();
        }
      }, delay);
    }

    async function connect() {
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers ?? {} },
      });
      transport.onclose = () => {
        console.log('[MCP] Transport closed');
        scheduleReconnect();
      };
      transport.onerror = (e) => {
        console.error('[MCP] Transport error:', e?.message ?? e);
      };

      client = new Client(
        { name: 'letta-mcp-channel', version: '0.1.0' },
        { capabilities: {} },
      );

      client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notif) => {
        await handleUpdate(notif.params.uri);
      });
      client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        await handleListChanged();
      });

      console.log(`[MCP] Connecting to ${config.url}`);
      await client.connect(transport);

      await deriveSubscriptions();
      for (const uri of uriToChatId.keys()) {
        await client.subscribeResource({ uri });
      }

      const rules = loadRules();
      reconnectDelay = rules.reconnect_initial_ms;
      console.log(`[MCP] Connected; subscribed to ${uriToChatId.size} resource(s)`);

      // Optional handshake: invoke configured tools right after connecting.
      // Useful for servers that require an init/auth tool call or a
      // "start streaming" toggle before they push notifications.
      if (Array.isArray(config.bootstrap_tools)) {
        for (const t of config.bootstrap_tools) {
          if (!t?.name) continue;
          try {
            const r = await client.callTool({ name: t.name, arguments: t.arguments ?? {} });
            console.log(`[MCP] bootstrap ${t.name}:`, r.content?.[0]?.text?.slice(0, 120));
          } catch (e) {
            console.error(`[MCP] bootstrap ${t.name} failed:`, e.message);
          }
        }
      }
    }

    const adapter = {
      id: `mcp:${account.accountId}`,
      channelId: 'mcp',
      accountId: account.accountId,
      name: account.displayName ?? 'MCP',

      async start() {
        if (running) return;
        running = true;
        try {
          await connect();
        } catch (e) {
          console.error('[MCP] Initial connect failed:', e.message);
          scheduleReconnect();
        }
      },

      async stop() {
        if (!running) return;
        running = false;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        try {
          await client?.close();
        } catch {
          // closing on shutdown — ignore
        }
        client = null;
        transport = null;
        console.log('[MCP] Adapter stopped');
      },

      isRunning() {
        return running;
      },

      async sendMessage(msg) {
        // Read-only channel. The agent replies by calling MCP tools through
        // Letta's native MCP integration (.mcp.json). Suppress any send.
        console.log(`[MCP] sendMessage suppressed (chatId=${msg?.chatId}): ${(msg?.text ?? '').slice(0, 80)}`);
        return { messageId: `mcp-suppressed-${Date.now()}` };
      },

      async sendDirectReply(chatId, text) {
        // Letta calls this for system messages (pairing codes, "not connected"
        // notices) when no route exists. There is no return path to the MCP
        // server, so suppress silently — mirroring the bluesky channel.
        console.log(`[MCP] sendDirectReply suppressed (chatId=${chatId}): ${text.slice(0, 80)}`);
      },

      onMessage: undefined,
    };

    return adapter;
  },

  // Declares that the agent's MessageChannel tool can target this channel.
  // The MCP channel is read-only: the handler does NOT post anything back to
  // the MCP server. It records the agent's intent in the server log and
  // returns a message reminding the agent to use a real MCP tool (configured
  // via Letta's native MCP integration in `.mcp.json`) to take action.
  messageActions: {
    describeMessageTool() {
      return { actions: ['send'] };
    },
    async handleAction({ request, formatText }) {
      const formatted = formatText(request.message ?? '');
      const preview = (formatted.text ?? '').slice(0, 120);
      console.log(`[MCP] MessageChannel.send acknowledged (chatId=${request.chatId}): ${preview}`);
      return 'Acknowledged — the mcp channel is read-only and did not post anything to the MCP server. To take action, call a tool from the same MCP server through your native MCP integration (.mcp.json).';
    },
  },
};
