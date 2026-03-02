"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = register;
const ws_1 = __importDefault(require("ws"));
// ── Reconnect backoff schedule (ms) ─────────────────────────────────────────
const BACKOFF_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
// ── Per-account WebSocket state ──────────────────────────────────────────────
const connections = new Map();
function makeState() {
    return { ws: null, backoffIndex: 0, reconnectTimer: null, stopped: false, pingInterval: null };
}
// ── Connection logic ─────────────────────────────────────────────────────────
function connect(api, ctx, accountId, account) {
    const state = connections.get(accountId) ?? makeState();
    connections.set(accountId, state);
    state.stopped = false;
    const displayName = (account.name ?? 'Klaws 🐾').slice(0, 24);
    const wsUrl = `${account.url.replace(/\/$/, '')}/${account.topic}`;
    const ws = new ws_1.default(wsUrl);
    state.ws = ws;
    ws.on('open', () => {
        // Server will send auth_required — we respond there
    });
    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        switch (msg.type) {
            case 'auth_required':
                ws.send(JSON.stringify({ type: 'auth', passkey: account.passkey, name: displayName }));
                break;
            case 'welcome':
                state.backoffIndex = 0; // successful auth — reset backoff
                api.logger?.info(`[clawmeet:${accountId}] Connected to #${account.topic} as ${displayName}`);
                break;
            case 'auth_fail':
                if (msg.retryAfter) {
                    // Rate-limited by server — wait the specified amount, then reconnect
                    api.logger?.warn(`[clawmeet:${accountId}] Rate-limited, retrying in ${msg.retryAfter}ms`);
                    scheduleReconnect(api, ctx, accountId, account, msg.retryAfter);
                }
                else {
                    // Wrong passkey — stop reconnecting (operator needs to fix config)
                    api.logger?.error(`[clawmeet:${accountId}] Auth failed for #${account.topic} — wrong passkey. ` +
                        `Check your openclaw.json config. Stopping reconnects.`);
                    state.stopped = true;
                }
                ws.close();
                break;
            case 'error':
                api.logger?.error(`[clawmeet:${accountId}] Server error: ${msg.text}`);
                break;
            case 'chat':
                // Ignore own messages
                if (msg.name === displayName)
                    break;
                dispatchMessage(ctx, accountId, msg);
                break;
            // 'system', 'online', 'welcome' — no action needed for these in the plugin
        }
    });
    ws.on('close', () => {
        clearPing(state);
        if (state.stopped)
            return;
        scheduleReconnect(api, ctx, accountId, account);
    });
    ws.on('error', (err) => {
        api.logger?.error(`[clawmeet:${accountId}] WS error: ${err.message}`);
        // 'close' fires after 'error', reconnect happens there
    });
    // Keepalive ping every 30s to prevent proxy/NAT timeout
    state.pingInterval = setInterval(() => {
        if (ws.readyState === ws_1.default.OPEN)
            ws.ping();
        else
            clearPing(state);
    }, 30_000);
}
function scheduleReconnect(api, ctx, accountId, account, overrideMs) {
    const state = connections.get(accountId);
    if (!state || state.stopped)
        return;
    const delayMs = overrideMs ?? BACKOFF_DELAYS[Math.min(state.backoffIndex, BACKOFF_DELAYS.length - 1)];
    state.backoffIndex = Math.min(state.backoffIndex + 1, BACKOFF_DELAYS.length - 1);
    api.logger?.info(`[clawmeet:${accountId}] Reconnecting in ${delayMs}ms…`);
    state.reconnectTimer = setTimeout(() => connect(api, ctx, accountId, account), delayMs);
}
function clearPing(state) {
    if (state.pingInterval) {
        clearInterval(state.pingInterval);
        state.pingInterval = null;
    }
}
function stopAccount(accountId) {
    const state = connections.get(accountId);
    if (!state)
        return;
    state.stopped = true;
    if (state.reconnectTimer)
        clearTimeout(state.reconnectTimer);
    clearPing(state);
    state.ws?.close();
    connections.delete(accountId);
}
// ── Message dispatch to OpenClaw agent ──────────────────────────────────────
function dispatchMessage(ctx, accountId, msg) {
    const senderId = `clawmeet:${accountId}:${msg.name}`;
    ctx.inbound?.dispatch({
        senderId,
        text: msg.text,
        channel: 'group',
        accountId,
        meta: { color: msg.color, ts: msg.ts },
    });
}
// ── Plugin export ────────────────────────────────────────────────────────────
function register(api) {
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
            listAccountIds: (cfg) => Object.keys(cfg?.channels?.clawmeet?.accounts ?? {}),
            resolveAccount: (cfg, accountId) => cfg?.channels?.clawmeet?.accounts?.[accountId ?? 'default'],
        },
        gateway: {
            // Using legacy start(ctx, accountId) signature — ctx has inbound dispatch capability.
            // If OpenClaw ever removes the legacy shim, switch to startAccount + ctx.runtime.channel.reply.
            start: async (ctx, accountId) => {
                const account = ctx.cfg?.channels?.clawmeet?.accounts?.[accountId];
                if (!account) {
                    api.logger?.warn(`[clawmeet] No config found for account "${accountId}"`);
                    return;
                }
                if (account.enabled === false) {
                    api.logger?.info(`[clawmeet:${accountId}] Skipped (disabled)`);
                    return;
                }
                connect(api, ctx, accountId, account);
            },
            stop: async (ctx, accountId) => {
                stopAccount(accountId);
                api.logger?.info(`[clawmeet:${accountId}] Stopped`);
            },
        },
        outbound: {
            deliveryMode: 'direct',
            // Resolve "general" (topic name) or "default" (account id) → account id
            resolveTarget: (params) => {
                const accounts = params.cfg?.channels?.clawmeet?.accounts ?? {};
                const { to } = params;
                // Match by account id
                if (to && accounts[to])
                    return { ok: true, to };
                // Match by topic name
                for (const [accountId, account] of Object.entries(accounts)) {
                    if (account.topic === to)
                        return { ok: true, to: accountId };
                }
                // Fallback to 'default' if only one account or no match
                const ids = Object.keys(accounts);
                if (ids.length === 1)
                    return { ok: true, to: ids[0] };
                return { ok: false, error: new Error(`Unknown ClawMeet target "${to}"`) };
            },
            sendText: async (ctx) => {
                const accountId = ctx.accountId ?? ctx.to;
                const state = connections.get(accountId);
                if (!state?.ws || state.ws.readyState !== ws_1.default.OPEN) {
                    throw new Error(`Not connected to ClawMeet room (account: ${accountId})`);
                }
                state.ws.send(JSON.stringify({ type: 'chat', text: ctx.text }));
                return { channel: 'clawmeet', messageId: `clawmeet-${Date.now()}` };
            },
            // ClawMeet is text-only; send media as a caption + URL fallback
            sendMedia: async (ctx) => {
                const accountId = ctx.accountId ?? ctx.to;
                const state = connections.get(accountId);
                if (!state?.ws || state.ws.readyState !== ws_1.default.OPEN) {
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
//# sourceMappingURL=index.js.map