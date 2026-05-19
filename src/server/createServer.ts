import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionManager } from '../core/session/sessionManager.js';
import { registerTools } from './registerTools.js';
import { CONTINUITY_PROMPT_TEXT } from '../prompts/continuityPrompt.js';

export const SERVER_NAME = 'kairo';
export const SERVER_VERSION = '0.5.2';

/**
 * Builds the MCP server and binds tools, the cooperation prompt, and read-only state
 * resources. Transport-agnostic: the caller connects a transport (see index.ts).
 */
export function createServer(sessions: SessionManager): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerTools(server, sessions);

  server.registerPrompt(
    'kairo_continuity',
    {
      title: 'Kairo continuity contract',
      description: 'How an agent must cooperate with Kairo to preserve engineering memory.',
    },
    () => ({
      messages: [{ role: 'user', content: { type: 'text', text: CONTINUITY_PROMPT_TEXT } }],
    }),
  );

  server.registerResource(
    'kairo-current-session',
    'kairo://session/current',
    {
      title: 'Current Kairo session',
      description: 'Live projection of the active session ledger and pressure.',
      mimeType: 'application/json',
    },
    () => {
      let body: unknown;
      try {
        const { state, pressure } = sessions.status();
        body = { state, pressure };
      } catch {
        body = { active: false, message: 'No active session. Call kairo_session_start.' };
      }
      return {
        contents: [
          {
            uri: 'kairo://session/current',
            mimeType: 'application/json',
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'kairo-latest-checkpoint',
    'kairo://checkpoint/latest',
    {
      title: 'Latest Kairo checkpoint',
      description: 'The most recent durable checkpoint across all sessions.',
      mimeType: 'application/json',
    },
    async () => {
      const cp = await sessions.latestCheckpoint();
      return {
        contents: [
          {
            uri: 'kairo://checkpoint/latest',
            mimeType: 'application/json',
            text: JSON.stringify(cp ?? { found: false }, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
