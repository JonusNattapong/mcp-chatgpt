#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { program } from 'commander';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ChatGPTClient } from './chatgpt-client.js';
import { applyFilePatch, runShellCommand, type ShellKind } from './shell-tools.js';
import type { ChatGPTConfig } from './types.js';

program
  .name('mcp-chatgpt')
  .description('MCP Server for interacting with ChatGPT Web via browser automation & Chrome Profiles')
  .option('--headed', 'Run browser in headed (visible) mode', false)
  .option('--login', 'Open browser in interactive mode to log in to ChatGPT', false)
  .option('--profile <name_or_id>', 'Select specific Chrome Profile (e.g. "Default", "Profile 1", or Name/Email)')
  .option('--chrome', 'Use installed Google Chrome browser', true)
  .option('--no-chrome', 'Use Playwright bundled Chromium instead of Google Chrome')
  .option('--user-data-dir <path>', 'Custom browser profile directory')
  .option('--cdp <endpoint>', 'Connect to an existing Chrome browser via CDP endpoint')
  .option('--bridge-port <port>', 'Port for Chrome Extension bridge WebSocket', '18999')
  .option('--bridge-only', 'Run only the Chrome Extension WebSocket bridge server', false)
  .option('--shell-root <path>', 'Restrict shell and patch tools to this directory', process.cwd())
  .option('--shell-max-timeout <ms>', 'Maximum shell command timeout in milliseconds', '300000')
  .option('--http', 'Expose an MCP Streamable HTTP endpoint for a tunnel/remote client', false)
  .option('--http-host <host>', 'HTTP bind host (default: 127.0.0.1)', '127.0.0.1')
  .option('--http-port <port>', 'HTTP port for the MCP endpoint', '8787')
  .option('--http-token <token>', 'Bearer token required by remote MCP clients (or MCP_HTTP_TOKEN)')
  .option('--timeout <ms>', 'Default timeout in milliseconds', '120000');

program.parse(process.argv);
const options = program.opts();

const config: ChatGPTConfig = {
  headless: !options.headed && !options.login,
  userDataDir: options.userDataDir,
  cdpEndpoint: options.cdp,
  useChrome: options.chrome,
  selectedProfile: options.profile,
  bridgePort: parseInt(options.bridgePort, 10),
  timeoutMs: parseInt(options.timeout, 10),
};

const client = new ChatGPTClient(config);
const shellRoot = String(options.shellRoot);
const shellMaxTimeoutMs = parseInt(options.shellMaxTimeout, 10);
const httpHost = String(options.httpHost);
const httpPort = parseInt(options.httpPort, 10);
const httpToken = options.httpToken ? String(options.httpToken) : process.env.MCP_HTTP_TOKEN;
if (!Number.isFinite(shellMaxTimeoutMs) || shellMaxTimeoutMs < 100) {
  throw new Error('--shell-max-timeout must be a number of at least 100 milliseconds.');
}
if (options.http && (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535)) {
  throw new Error('--http-port must be an integer between 1 and 65535.');
}
if (options.http && !httpToken) {
  throw new Error('HTTP mode requires --http-token or MCP_HTTP_TOKEN.');
}

async function runBridgeOnlyMode(): Promise<void> {
  console.log(`[MCP Bridge] Bridge WebSocket server listening on ws://127.0.0.1:${config.bridgePort}`);
  console.log(`[MCP Bridge] You can now connect the Chrome Extension from your browser.`);
  console.log(`[MCP Bridge] Press Ctrl+C to stop.`);

  // Keep process alive
  await new Promise<void>(() => {});
}

async function runLoginMode(): Promise<void> {
  console.log('Starting ChatGPT login session in visible browser...');
  console.log('Please log in with your ChatGPT account in the browser window.');
  await client.initialize({ headed: true, profile: options.profile });
  console.log('Browser launched at https://chatgpt.com.');
  console.log('Once you are logged in and see the chat interface, press Ctrl+C to finish.');

  // Keep process alive until user exits
  await new Promise<void>(() => {});
}

async function main() {
  if (options.bridgeOnly) {
    await runBridgeOnlyMode();
    return;
  }

  if (options.login) {
    await runLoginMode();
    return;
  }

  const server = new Server(
    {
      name: 'mcp-chatgpt',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'shell_command',
          description:
            'Run a command with a working directory inside the configured shell root. Uses PowerShell on Windows and Bash on Linux/macOS by default. The command has the same OS permissions as this MCP server.',
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Command to execute.' },
              workdir: {
                type: 'string',
                description: 'Working directory relative to the configured shell root (default: root).',
              },
              shell: {
                type: 'string',
                enum: ['auto', 'powershell', 'bash'],
                description: 'Shell to use (default: auto).',
              },
              timeout_ms: {
                type: 'number',
                description: 'Command timeout in milliseconds (default: 30000; bounded by server configuration).',
              },
            },
            required: ['command'],
          },
        },
        {
          name: 'apply_patch',
          description:
            'Safely add, update, delete, or move files inside the configured shell root using an *** Begin Patch / *** End Patch patch. Prefer this over shell redirection for code edits.',
          inputSchema: {
            type: 'object',
            properties: {
              patch: {
                type: 'string',
                description: 'Patch text containing Add File, Update File, or Delete File operations.',
              },
            },
            required: ['patch'],
          },
        },
        {
          name: 'chatgpt_ask',
          description:
            'Send a question or prompt to ChatGPT Web (chatgpt.com) and get the assistant response. Supports Web Search, o1/o3-mini reasoning, model selection, code extraction, image/file attachments, and Chrome profiles.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'The message, question, or instruction to send to ChatGPT Web.',
              },
              web_search: {
                type: 'boolean',
                description: 'Enable live Web Search toggle in ChatGPT for up-to-date web information.',
              },
              model: {
                type: 'string',
                description: 'Target ChatGPT model name (e.g. "gpt-4o", "o3-mini", "o1", "canvas").',
              },
              reasoning_effort: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
                description: 'Set reasoning effort for o-series models (low, medium, high).',
              },
              extract_code_only: {
                type: 'boolean',
                description: 'If true, extracts and returns only the code blocks from the ChatGPT response.',
              },
              auto_continue: {
                type: 'boolean',
                description: 'Automatically click "Continue generating" if response is cut off (default: true).',
              },
              image_paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of absolute file paths to images to upload/attach for multimodal analysis.',
              },
              file_paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of absolute file paths to documents/code files to upload/attach.',
              },
              profile: {
                type: 'string',
                description:
                  'Optional Chrome profile name or ID (e.g. "Default", "Profile 1", or email/name) to send this question through.',
              },
              new_chat: {
                type: 'boolean',
                description: 'Set to true to start a new chat conversation before asking.',
              },
              conversation_id: {
                type: 'string',
                description:
                  'Optional conversation ID (e.g. "67b...") or conversation URL (e.g. "https://chatgpt.com/c/...") to continue a specific thread.',
              },
              refresh_page: {
                type: 'boolean',
                description: 'Set to true to reload/refresh the ChatGPT page before sending this message (useful when stuck).',
              },
              timeout_ms: {
                type: 'number',
                description: 'Optional timeout in milliseconds to wait for the complete answer.',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'chatgpt_list_profiles',
          description:
            'List all detected Google Chrome profiles available on this machine (including Profile Folder ID, Display Name, Email).',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'chatgpt_select_profile',
          description:
            'Select which Chrome profile to use for ChatGPT Web automation (by Profile Folder ID, Display Name, or Email).',
          inputSchema: {
            type: 'object',
            properties: {
              profile: {
                type: 'string',
                description: 'The profile ID (e.g. "Default", "Profile 1"), Display Name, or Email to activate.',
              },
            },
            required: ['profile'],
          },
        },
        {
          name: 'chatgpt_new_chat',
          description: 'Start a clean/new conversation on ChatGPT Web.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'chatgpt_reload',
          description: 'Reload and refresh the current ChatGPT Web page to fix stuck conversations or connection glitches.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'chatgpt_get_latest_response',
          description:
            'Fetch and recover the latest assistant response (including text, code blocks, and images) from the current or specified conversation without asking a new question. Useful after recovering from a timeout or reload.',
          inputSchema: {
            type: 'object',
            properties: {
              conversation_id: {
                type: 'string',
                description: 'Optional conversation ID or URL to fetch the latest answer from.',
              },
              refresh_first: {
                type: 'boolean',
                description: 'Whether to reload the page before reading the latest response (default: true).',
              },
            },
          },
        },
        {
          name: 'chatgpt_get_status',
          description:
            'Get the current status of ChatGPT Web automation (initialized, logged in, active profile, extension bridge status, current conversation URL, title, model).',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'chatgpt_list_conversations',
          description:
            'List recent conversation history topics and IDs from the ChatGPT sidebar so you can select and resume any previous chat.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of recent conversations to retrieve (default: 30).',
              },
            },
          },
        },
        {
          name: 'chatgpt_list_models',
          description:
            'List all available AI models (e.g. GPT-5.6 Sol, GPT-5.5, o3, gpt-4o, o1) and reasoning effort options for this ChatGPT account.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'chatgpt_login',
          description:
            'Open ChatGPT Web in a visible (headed) browser window so the user can log in or solve Captcha challenges.',
          inputSchema: {
            type: 'object',
            properties: {
              profile: {
                type: 'string',
                description: 'Optional Chrome profile to log into.',
              },
            },
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'shell_command') {
        const command = String(args?.command || '');
        const result = await runShellCommand({
          command,
          root: shellRoot,
          workdir: args?.workdir ? String(args.workdir) : undefined,
          shell: (args?.shell ? String(args.shell) : 'auto') as ShellKind,
          timeoutMs: args?.timeout_ms !== undefined ? Number(args.timeout_ms) : undefined,
          maxTimeoutMs: shellMaxTimeoutMs,
        });
        const output = [
          `Shell: ${result.shell}`,
          `Working directory: ${result.workdir}`,
          `Exit code: ${result.exitCode ?? 'none'}`,
          result.timedOut ? 'Timed out: yes' : '',
          result.stdout ? `\nSTDOUT:\n${result.stdout}` : '',
          result.stderr ? `\nSTDERR:\n${result.stderr}` : '',
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text: output }], isError: result.exitCode !== 0 || result.timedOut };
      }

      if (name === 'apply_patch') {
        const patch = String(args?.patch || '');
        if (!patch) throw new Error('"patch" parameter is required.');
        const changed = await applyFilePatch(shellRoot, patch);
        return { content: [{ type: 'text', text: `Patch applied successfully:\n${changed.join('\n')}` }] };
      }

      if (name === 'chatgpt_list_profiles') {
        const profiles = client.listProfiles();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(profiles, null, 2),
            },
          ],
        };
      }

      if (name === 'chatgpt_select_profile') {
        const profileInput = String(args?.profile || '');
        const selected = client.selectProfile(profileInput);
        return {
          content: [
            {
              type: 'text',
              text: `Selected Chrome Profile: "${selected.name}" [${selected.id}]${selected.email ? ` (${selected.email})` : ''}`,
            },
          ],
        };
      }

      if (name === 'chatgpt_ask') {
        const message = String(args?.message || '');
        if (!message) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: "message" parameter is required.',
              },
            ],
            isError: true,
          };
        }

        const profile = args?.profile ? String(args.profile) : undefined;
        const model = args?.model ? String(args.model) : undefined;
        const webSearch = typeof args?.web_search === 'boolean' ? Boolean(args.web_search) : undefined;
        const reasoningEffort = args?.reasoning_effort as any;
        const extractCodeOnly = Boolean(args?.extract_code_only);
        const autoContinue = args?.auto_continue !== undefined ? Boolean(args.auto_continue) : true;
        const imagePaths = Array.isArray(args?.image_paths) ? (args.image_paths as string[]) : undefined;
        const filePaths = Array.isArray(args?.file_paths) ? (args.file_paths as string[]) : undefined;
        const newChat = Boolean(args?.new_chat);
        const conversationId = args?.conversation_id ? String(args.conversation_id) : undefined;
        const refreshPage = Boolean(args?.refresh_page);
        const timeoutMs = args?.timeout_ms ? Number(args.timeout_ms) : undefined;

        const response = await client.ask({
          message,
          profile,
          model,
          webSearch,
          reasoningEffort,
          extractCodeOnly,
          autoContinue,
          imagePaths,
          filePaths,
          newChat,
          conversationId,
          refreshPage,
          timeoutMs,
        });

        const contents: any[] = [
          {
            type: 'text',
            text: response.content,
          },
        ];

        if (response.extractedCode && response.extractedCode.length > 0) {
          contents.push({
            type: 'text',
            text: `\n\n### Extracted Code Blocks:\n\`\`\`\n${response.extractedCode.join('\n\n')}\n\`\`\``,
          });
        }

        if (response.imageUrls && response.imageUrls.length > 0) {
          contents.push({
            type: 'text',
            text: `\n\n### Generated Images:\n${response.imageUrls.map((u) => `![Generated Image](${u})`).join('\n')}`,
          });
        }

        contents.push({
          type: 'text',
          text: `\n\n---\n*Profile:* ${response.profileUsed || 'Default'}${response.model ? ` | *Model:* ${response.model}` : ''}${response.webSearchUsed ? ' | *Web Search:* Enabled' : ''}${response.conversationUrl ? ` | *Conversation URL:* ${response.conversationUrl}` : ''}`,
        });

        return { content: contents };
      }

      if (name === 'chatgpt_reload') {
        const result = await client.reloadPage();
        return {
          content: [
            {
              type: 'text',
              text: result.message || 'ChatGPT page reloaded successfully.',
            },
          ],
        };
      }

      if (name === 'chatgpt_get_latest_response') {
        const conversationId = args?.conversation_id ? String(args.conversation_id) : undefined;
        const refreshFirst = args?.refresh_first !== undefined ? Boolean(args.refresh_first) : true;
        const response = await client.getLatestResponse(conversationId, refreshFirst);

        const contents: any[] = [
          {
            type: 'text',
            text: response.content,
          },
        ];

        if (response.extractedCode && response.extractedCode.length > 0) {
          contents.push({
            type: 'text',
            text: `\n\n### Extracted Code Blocks:\n\`\`\`\n${response.extractedCode.join('\n\n')}\n\`\`\``,
          });
        }

        if (response.imageUrls && response.imageUrls.length > 0) {
          contents.push({
            type: 'text',
            text: `\n\n### Generated Images:\n${response.imageUrls.map((u) => `![Generated Image](${u})`).join('\n')}`,
          });
        }

        contents.push({
          type: 'text',
          text: `\n\n---\n*Profile:* ${response.profileUsed || 'Default'}${response.conversationUrl ? ` | *Conversation URL:* ${response.conversationUrl}` : ''}`,
        });

        return { content: contents };
      }

      if (name === 'chatgpt_new_chat') {
        const result = await client.newChat();
        return {
          content: [
            {
              type: 'text',
              text: `Started a new ChatGPT conversation.\nURL: ${result.url}`,
            },
          ],
        };
      }

      if (name === 'chatgpt_list_conversations') {
        const limit = typeof args?.limit === 'number' ? Number(args.limit) : 30;
        const conversations = await client.listConversations(limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(conversations, null, 2),
            },
          ],
        };
      }

      if (name === 'chatgpt_list_models') {
        const models = await client.listModels();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(models, null, 2),
            },
          ],
        };
      }

      if (name === 'chatgpt_get_status') {
        const status = await client.getStatus();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      }

      if (name === 'chatgpt_login') {
        const profile = args?.profile ? String(args.profile) : undefined;
        await client.initialize({ headed: true, profile });
        const status = await client.getStatus();
        return {
          content: [
            {
              type: 'text',
              text: `Browser window opened for profile "${status.activeProfile || 'Default'}". Current status: ${JSON.stringify(status, null, 2)}.\nPlease log in to ChatGPT in the opened browser window.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `Unknown tool: ${name}`,
          },
        ],
        isError: true,
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error executing ${name}: ${err?.message || String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  let closeTransport: (() => Promise<void>) | undefined;
  let closeHttpServer: (() => Promise<void>) | undefined;

  if (options.http) {
    // Stateless Streamable HTTP keeps this existing Server instance reusable for
    // remote requests while the tunnel/HTTP process is alive.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    const httpServer = createServer(async (req, res) => {
      addCorsHeaders(res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === '/healthz' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'mcp-chatgpt', endpoint: '/mcp' }));
        return;
      }
      if (req.url !== '/mcp') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      if (!hasValidBearerToken(req, httpToken!)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      try {
        await transport.handleRequest(req, res);
      } catch (error: any) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: error?.message || String(error) }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(httpPort, httpHost, () => resolve());
    });
    console.error(`[MCP HTTP] Streamable HTTP endpoint listening at http://${httpHost}:${httpPort}/mcp`);
    console.error('[MCP HTTP] Remote access requires the configured Bearer token and an active tunnel.');
    closeTransport = () => transport.close();
    closeHttpServer = () => new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  const cleanup = async () => {
    await closeTransport?.();
    await closeHttpServer?.();
    await client.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

function addCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version, last-event-id');
}

function hasValidBearerToken(req: IncomingMessage, expectedToken: string): boolean {
  const value = req.headers.authorization;
  const prefix = 'Bearer ';
  if (!value || !value.startsWith(prefix)) return false;
  const actual = Buffer.from(value.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

main().catch((err) => {
  console.error('Fatal error in mcp-chatgpt server:', err);
  process.exit(1);
});
