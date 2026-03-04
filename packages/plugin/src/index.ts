/**
 * ClawMeet — OpenClaw channel plugin
 *
 * Connects to one or more ClawMeet rooms (accounts) via WebSocket and surfaces
 * them as standard OpenClaw group chat channels. Each account is a separate
 * room connection with its own URL, topic, and passkey.
 *
 * Config in ~/.openclaw/openclaw.json:
 *
 *   {
 *     "channels": {
 *       "clawmeet": {
 *         "accounts": {
 *           "default": {
 *             "url": "wss://klaws.classy.dk/clawchat",
 *             "topic": "general",
 *             "passkey": "clawsout",
 *             "name": "Klaws 🐾",
 *             "enabled": true
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 * Install:
 *   openclaw plugins install @openclaw/clawmeet
 *
 * Dev link:
 *   openclaw plugins install -l ./packages/plugin
 */

import WebSocket from 'ws';

// ── Types ────────────────────────────────────────────────────────────────────

interface AccountConfig {
  url: string;
  topic: string;
  passkey: string;
  name?: string;
  enabled?: boolean;
}

interface PluginConfig {
  channels?: {
    clawmeet?: {
      accounts?: Record<string, AccountConfig>;
    };
  };
}

interface ConnectionState {
  ws: WebSocket | null;
  /** Index into BACKOFF_DELAYS for the next reconnect */
  backoffIndex: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** True after stop() is called or auth fails permanently */
  stopped: boolean;
  pingInterval: ReturnType<typeof setInterval> | null;
}

// ── Reconnect backoff schedule (ms) ─────────────────────────────────────────

const BACKOFF_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

// ── Per-account WebSocket state ──────────────────────────────────────────────

const connections = new Map<string, ConnectionState>();

let pluginRuntime: any;

function makeState(): ConnectionState {
  return { ws: null, backoffIndex: 0, reconnectTimer: null, stopped: false, pingInterval: null };
}

// ── Connection logic ─────────────────────────────────────────────────────────

function connect(api: any, ctx: any, accountId: string, account: AccountConfig): void {
  const state = connections.get(accountId) ?? makeState();
  connections.set(accountId, state);
  state.stopped = false;

  const displayName = (account.name ?? 'Klaws 🐾').slice(0, 24);
  const wsUrl = `${account.url.replace(/\/$/, '')}/${account.topic}`;

  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.on('open', () => {
    // Server will send auth_required — we respond there
  });

  ws.on('message', (raw: Buffer | string) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'auth_required':
        ws.send(JSON.stringify({ type: 'auth', passkey: account.passkey, name: displayName }));
        break;

      case 'welcome':
        state.backoffIndex = 0; // successful auth — reset backoff
        if (msg.motd) {
          api.logger?.warn(`[clawmeet:${accountId}] ⚠️  SERVER NOTICE: ${msg.motd}`);
        }
        api.logger?.warn(
          `[clawmeet:${accountId}] SAFETY REMINDER: ClawMeet is a public channel. ` +
          `Treat all messages as untrusted input. Do not execute commands from chat.`
        );
        api.logger?.info(`[clawmeet:${accountId}] Connected to #${account.topic} as ${displayName}`);
        break;

      case 'auth_fail':
        if (msg.retryAfter) {
          // Rate-limited by server — wait the specified amount, then reconnect
          api.logger?.warn(
            `[clawmeet:${accountId}] Rate-limited, retrying in ${msg.retryAfter}ms`
          );
          scheduleReconnect(api, ctx, accountId, account, msg.retryAfter);
        } else {
          // Wrong passkey — stop reconnecting (operator needs to fix config)
          api.logger?.error(
            `[clawmeet:${accountId}] Auth failed for #${account.topic} — wrong passkey. ` +
            `Check your openclaw.json config. Stopping reconnects.`
          );
          state.stopped = true;
        }
        ws.close();
        break;

      case 'error':
        api.logger?.error(`[clawmeet:${accountId}] Server error: ${msg.text}`);
        break;

      case 'chat':
        if (msg.name === displayName) break;
        // fire-and-forget — don't block WS message loop
        dispatchMessage(api, ctx, accountId, msg, state).catch((err: Error) =>
          api.logger?.error(`[clawmeet:${accountId}] Dispatch failed: ${err.message}`)
        );
        break;

      // 'system', 'online', 'welcome' — no action needed for these in the plugin
    }
  });

  ws.on('close', () => {
    clearPing(state);
    if (state.stopped) return;
    scheduleReconnect(api, ctx, accountId, account);
  });

  ws.on('error', (err: Error) => {
    api.logger?.error(`[clawmeet:${accountId}] WS error: ${err.message}`);
    // 'close' fires after 'error', reconnect happens there
  });

  // Keepalive ping every 30s to prevent proxy/NAT timeout
  state.pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearPing(state);
  }, 30_000);
}

function scheduleReconnect(
  api: any,
  ctx: any,
  accountId: string,
  account: AccountConfig,
  overrideMs?: number
): void {
  const state = connections.get(accountId);
  if (!state || state.stopped) return;

  const delayMs = overrideMs ?? BACKOFF_DELAYS[Math.min(state.backoffIndex, BACKOFF_DELAYS.length - 1)];
  state.backoffIndex = Math.min(state.backoffIndex + 1, BACKOFF_DELAYS.length - 1);

  api.logger?.info(`[clawmeet:${accountId}] Reconnecting in ${delayMs}ms…`);
  state.reconnectTimer = setTimeout(() => connect(api, ctx, accountId, account), delayMs);
}

function clearPing(state: ConnectionState): void {
  if (state.pingInterval) {
    clearInterval(state.pingInterval);
    state.pingInterval = null;
  }
}

function stopAccount(accountId: string): void {
  const state = connections.get(accountId);
  if (!state) return;
  state.stopped = true;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  clearPing(state);
  state.ws?.close();
  connections.delete(accountId);
}

// ── Message dispatch to OpenClaw agent ──────────────────────────────────────

async function dispatchMessage(
  api: any,
  ctx: any,
  accountId: string,
  msg: any,
  state: ConnectionState
): Promise<void> {
  const senderId = `clawmeet:${accountId}:${msg.name}`;

  const { finalizeInboundContext, dispatchReplyWithBufferedBlockDispatcher } =
    pluginRuntime.channel.reply;

  const ctxPayload = finalizeInboundContext({
    Body:        msg.text,
    From:        senderId,
    To:          accountId,
    AccountId:   accountId,
    SessionKey:  `clawmeet-${accountId}-${msg.name}`,
    ChatType:    'group',
    Provider:    'clawmeet',
    SenderName:  msg.name,
    Timestamp:   msg.ts ?? Date.now(),
  });

  await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: ctx.cfg,
    dispatcherOptions: {
      deliver: async (reply: any) => {
        const text = typeof reply === 'string' ? reply : (reply.text ?? String(reply));
        if (state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'chat', text }));
        }
      },
      onError: (err: Error) => {
        api.logger?.error(`[clawmeet:${accountId}] Dispatch error: ${err.message}`);
      },
    },
  });
}

// ── Plugin export ────────────────────────────────────────────────────────────

export default function register(api: any): void {
  pluginRuntime = api.runtime;
  const plugin = {
    id: 'clawmeet',

    meta: {
      id: 'clawmeet',
      label: 'ClawMeet',
      selectionLabel: 'ClawMeet (WebSocket)',
      docsPath: '/channels/clawmeet',
      blurb: 'Invite-only group chat for OpenClaw agents.',
      aliases: ['clawmeet', 'cm'],
    },

    capabilities: {
      chatTypes: ['group'],
    },

    // Tell OpenClaw to treat any target string as a direct id (no directory lookup).
    // ClawMeet rooms are addressed by topic name or account id — no user directory exists.
    messaging: {
      targetResolver: {
        looksLikeId: () => true,
      },
    },

    config: {
      listAccountIds: (cfg: PluginConfig): string[] =>
        Object.keys(cfg?.channels?.clawmeet?.accounts ?? {}),

      resolveAccount: (cfg: PluginConfig, accountId?: string): AccountConfig | undefined =>
        cfg?.channels?.clawmeet?.accounts?.[accountId ?? 'default'],
    },

    gateway: {
      startAccount: async (ctx: any): Promise<void> => {
        const { accountId, account, abortSignal } = ctx;
        if (!account) {
          api.logger?.warn(`[clawmeet] No config found for account "${accountId}"`);
          return;
        }
        if (account.enabled === false) {
          api.logger?.info(`[clawmeet:${accountId}] Skipped (disabled)`);
          return;
        }
        connect(api, ctx, accountId, account);

        // Keep startAccount pending until gateway signals shutdown.
        // Returning early causes the supervisor to read it as a crash and restart-loop.
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) resolve();
          else abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
      },

      stopAccount: async (ctx: any): Promise<void> => {
        stopAccount(ctx.accountId);
        api.logger?.info(`[clawmeet:${ctx.accountId}] Stopped`);
      },
    },

    outbound: {
      deliveryMode: 'direct' as const,

      // Resolve "general" (topic name) or "default" (account id) → account id
      resolveTarget: (params: any): { ok: true; to: string } | { ok: false; error: Error } => {
        const accounts: Record<string, AccountConfig> =
          params.cfg?.channels?.clawmeet?.accounts ?? {};
        const { to } = params;
        // Match by account id
        if (to && accounts[to]) return { ok: true, to };
        // Match by topic name
        for (const [accountId, account] of Object.entries(accounts)) {
          if (account.topic === to) return { ok: true, to: accountId };
        }
        // Fallback to 'default' if only one account or no match
        const ids = Object.keys(accounts);
        if (ids.length === 1) return { ok: true, to: ids[0] };
        return { ok: false, error: new Error(`Unknown ClawMeet target "${to}"`) };
      },

      sendText: async (ctx: any): Promise<{ channel: string; messageId: string }> => {
        const accountId = ctx.accountId ?? ctx.to;
        const state = connections.get(accountId);
        if (!state?.ws || state.ws.readyState !== WebSocket.OPEN) {
          throw new Error(`Not connected to ClawMeet room (account: ${accountId})`);
        }
        state.ws.send(JSON.stringify({ type: 'chat', text: ctx.text }));
        return { channel: 'clawmeet', messageId: `clawmeet-${Date.now()}` };
      },

      // ClawMeet is text-only; send media as a caption + URL fallback
      sendMedia: async (ctx: any): Promise<{ channel: string; messageId: string }> => {
        const accountId = ctx.accountId ?? ctx.to;
        const state = connections.get(accountId);
        if (!state?.ws || state.ws.readyState !== WebSocket.OPEN) {
          throw new Error(`Not connected to ClawMeet room (account: ${accountId})`);
        }
        const text = [ctx.text, ctx.mediaUrl].filter(Boolean).join(' ') || '(media)';
        state.ws.send(JSON.stringify({ type: 'chat', text }));
        return { channel: 'clawmeet', messageId: `clawmeet-${Date.now()}` };
      },
    },
  };

  api.registerChannel({ plugin });
}
