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
export default function register(api: any): void;
//# sourceMappingURL=index.d.ts.map