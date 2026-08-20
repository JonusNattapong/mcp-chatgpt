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
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ChatGPTClient } from './chatgpt-client.js';
import { applyFilePatch, runShellCommand, type ShellKind } from './shell-tools.js';
import type { ChatGPTConfig, LLMProvider } from './types.js';

program
  .name('mcp-chatgpt')
  .description('MCP Server for interacting with Web LLMs (ChatGPT, Gemini, Kimi, Z.ai) via browser automation & Chrome Profiles')
  .option('--headed', 'Run browser in headed (visible) mode', false)
  .option('--login', 'Open browser in interactive mode to log in', false)
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
  await new Promise<void>(() => {});
}

async function runLoginMode(): Promise<void> {
  console.log('Starting Web LLM login session in visible browser...');
  console.log('Please log in with your accounts in the browser window.');
  await client.initialize({ headed: true, profile: options.profile });
  console.log('Browser launched. Once you are logged in, press Ctrl+C to finish.');
  await new Promise<void>(() => {});
}

function formatChatResponse(response: any) {
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
      text: `\n\n### Generated Images:\n${response.imageUrls.map((u: string) => `![Generated Image](${u})`).join('\n')}`,
    });
  }

  contents.push({
    type: 'text',
    text: `\n\n---\n*Provider:* ${response.provider || 'chatgpt'} | *Profile:* ${response.profileUsed || 'Default'}${response.model ? ` | *Model:* ${response.model}` : ''}${response.webSearchUsed ? ' | *Web Search:* Enabled' : ''}${response.conversationUrl ? ` | *Conversation URL:* ${response.conversationUrl}` : ''}`,
  });

  return contents;
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
      name: 'mcp-web-llms',
      version: '1.1.0',
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
            'Run a command with a working directory inside the configured shell root. Uses PowerShell on Windows and Bash on Linux/macOS by default.',
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
                description: 'Command timeout in milliseconds (default: 30000).',
              },
            },
            required: ['command'],
          },
        },
        {
          name: 'apply_patch',
          description:
            'Safely add, update, delete, or move files inside the configured shell root using an *** Begin Patch / *** End Patch patch.',
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
        // --- Unified Tool ---
        {
          name: 'llm_ask',
          description:
            'Send a question to any supported Web LLM (ChatGPT, Google Gemini, Kimi AI, Z.ai) and receive the assistant response.',
          inputSchema: {
            type: 'object',
            properties: {
              provider: {
                type: 'string',
                enum: ['chatgpt', 'gemini', 'kimi', 'zai'],
                description: 'The Web LLM provider to query (chatgpt, gemini, kimi, or zai). Default is chatgpt.',
              },
              message: {
                type: 'string',
                description: 'The message, question, or instruction to send.',
              },
              profile: {
                type: 'string',
                description: 'Optional Chrome profile name or ID to use.',
              },
              new_chat: {
                type: 'boolean',
                description: 'Set to true to start a new chat conversation before asking.',
              },
              conversation_id: {
                type: 'string',
                description: 'Optional conversation ID or URL to resume an existing thread.',
              },
              extract_code_only: {
                type: 'boolean',
                description: 'If true, returns only extracted code blocks.',
              },
              timeout_ms: {
                type: 'number',
                description: 'Optional timeout in milliseconds.',
              },
            },
            required: ['message'],
          },
        },
        // --- ChatGPT Tools ---
        {
          name: 'chatgpt_ask',
          description:
            'Send a question or prompt to ChatGPT Web (chatgpt.com) and get the assistant response.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'The message to send to ChatGPT Web.' },
              web_search: { type: 'boolean', description: 'Enable live Web Search toggle in ChatGPT.' },
              model: { type: 'string', description: 'Target model name (e.g. "gpt-4o", "o3-mini", "o1").' },
              reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high'] },
              extract_code_only: { type: 'boolean' },
              auto_continue: { type: 'boolean' },
              image_paths: { type: 'array', items: { type: 'string' } },
              file_paths: { type: 'array', items: { type: 'string' } },
              profile: { type: 'string' },
              new_chat: { type: 'boolean' },
              conversation_id: { type: 'string' },
              refresh_page: { type: 'boolean' },
              timeout_ms: { type: 'number' },
            },
            required: ['message'],
          },
        },
        {
          name: 'chatgpt_new_chat',
          description: 'Start a clean/new conversation on ChatGPT Web.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'chatgpt_get_status',
          description: 'Get the current status of ChatGPT Web automation.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'chatgpt_list_profiles',
          description: 'List all detected Google Chrome profiles available on this machine.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'chatgpt_select_profile',
          description: 'Select which Chrome profile to use for browser automation.',
          inputSchema: {
            type: 'object',
            properties: {
              profile: { type: 'string', description: 'The profile ID, Display Name, or Email.' },
            },
            required: ['profile'],
          },
        },
        {
          name: 'chatgpt_list_conversations',
          description: 'List recent conversation history topics and IDs from the ChatGPT sidebar.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Max items (default 30).' },
            },
          },
        },
        {
          name: 'chatgpt_list_models',
          description: 'List all available AI models for ChatGPT.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'chatgpt_reload',
          description: 'Reload and refresh the current ChatGPT Web page.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'chatgpt_get_latest_response',
          description: 'Fetch and recover the latest assistant response from ChatGPT.',
          inputSchema: {
            type: 'object',
            properties: {
              conversation_id: { type: 'string' },
              refresh_first: { type: 'boolean' },
            },
          },
        },
        // --- Gemini Tools ---
        {
          name: 'gemini_ask',
          description:
            'Send a question or prompt to Google Gemini (gemini.google.com/app) and get the response.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'The message to send to Google Gemini.' },
              profile: { type: 'string', description: 'Optional Chrome profile with Google Account.' },
              new_chat: { type: 'boolean', description: 'Start a new conversation before asking.' },
              conversation_id: { type: 'string', description: 'Optional conversation ID or URL.' },
              extract_code_only: { type: 'boolean', description: 'Extract only code blocks.' },
              image_paths: { type: 'array', items: { type: 'string' } },
              file_paths: { type: 'array', items: { type: 'string' } },
              timeout_ms: { type: 'number' },
            },
            required: ['message'],
          },
        },
        {
          name: 'gemini_new_chat',
          description: 'Start a new conversation on Google Gemini Web.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'gemini_get_status',
          description: 'Get current status of Google Gemini Web automation.',
          inputSchema: { type: 'object', properties: {} },
        },
        // --- Kimi AI Tools ---
        {
          name: 'kimi_ask',
          description:
            'Send a question or prompt to Kimi AI (kimi.ai) and get the assistant response.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'The message to send to Kimi AI.' },
              profile: { type: 'string', description: 'Optional Chrome profile with Kimi session.' },
              new_chat: { type: 'boolean', description: 'Start a new conversation before asking.' },
              conversation_id: { type: 'string', description: 'Optional conversation ID or URL.' },
              extract_code_only: { type: 'boolean', description: 'Extract only code blocks.' },
              image_paths: { type: 'array', items: { type: 'string' } },
              file_paths: { type: 'array', items: { type: 'string' } },
              timeout_ms: { type: 'number' },
            },
            required: ['message'],
          },
        },
        {
          name: 'kimi_new_chat',
          description: 'Start a new conversation on Kimi AI Web.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'kimi_get_status',
          description: 'Get current status of Kimi AI Web automation.',
          inputSchema: { type: 'object', properties: {} },
        },
        // --- Z.ai (GLM) Tools ---
        {
          name: 'zai_ask',
          description:
            'Send a question or prompt to Z.ai (chat.z.ai) and get the assistant response.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'The message to send to Z.ai.' },
              profile: { type: 'string', description: 'Optional Chrome profile with Z.ai session.' },
              new_chat: { type: 'boolean', description: 'Start a new conversation before asking.' },
              conversation_id: { type: 'string', description: 'Optional conversation ID or URL.' },
              extract_code_only: { type: 'boolean', description: 'Extract only code blocks.' },
              image_paths: { type: 'array', items: { type: 'string' } },
              file_paths: { type: 'array', items: { type: 'string' } },
              timeout_ms: { type: 'number' },
            },
            required: ['message'],
          },
        },
        {
          name: 'zai_new_chat',
          description: 'Start a new conversation on Z.ai Web.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'zai_get_status',
          description: 'Get current status of Z.ai Web automation.',
          inputSchema: { type: 'object', properties: {} },
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
        return { content: [{ type: 'text', text: JSON.stringify(profiles, null, 2) }] };
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

      // --- Generic / Specific Ask Handlers ---
      if (name === 'llm_ask' || name === 'chatgpt_ask' || name === 'gemini_ask' || name === 'kimi_ask' || name === 'zai_ask') {
        const message = String(args?.message || '');
        if (!message) {
          return {
            content: [{ type: 'text', text: 'Error: "message" parameter is required.' }],
            isError: true,
          };
        }

        let provider: LLMProvider = 'chatgpt';
        if (name === 'gemini_ask') provider = 'gemini';
        else if (name === 'kimi_ask') provider = 'kimi';
        else if (name === 'zai_ask') provider = 'zai';
        else if (name === 'llm_ask' && args?.provider) {
          provider = String(args.provider).toLowerCase() as LLMProvider;
        }

        const response = await client.ask({
          provider,
          message,
          profile: args?.profile ? String(args.profile) : undefined,
          model: args?.model ? String(args.model) : undefined,
          webSearch: typeof args?.web_search === 'boolean' ? Boolean(args.web_search) : undefined,
          reasoningEffort: args?.reasoning_effort as any,
          extractCodeOnly: Boolean(args?.extract_code_only),
          autoContinue: args?.auto_continue !== undefined ? Boolean(args.auto_continue) : true,
          imagePaths: Array.isArray(args?.image_paths) ? (args.image_paths as string[]) : undefined,
          filePaths: Array.isArray(args?.file_paths) ? (args.file_paths as string[]) : undefined,
          newChat: Boolean(args?.new_chat),
          conversationId: args?.conversation_id ? String(args.conversation_id) : undefined,
          refreshPage: Boolean(args?.refresh_page),
          timeoutMs: args?.timeout_ms ? Number(args.timeout_ms) : undefined,
        });

        return { content: formatChatResponse(response) };
      }

      // --- New Chat Handlers ---
      if (name === 'chatgpt_new_chat' || name === 'gemini_new_chat' || name === 'kimi_new_chat' || name === 'zai_new_chat') {
        const provider: LLMProvider =
          name === 'gemini_new_chat' ? 'gemini' : name === 'kimi_new_chat' ? 'kimi' : name === 'zai_new_chat' ? 'zai' : 'chatgpt';
        const result = await client.newChat(provider);
        return {
          content: [{ type: 'text', text: `Started a new ${provider.toUpperCase()} conversation.\nURL: ${result.url}` }],
        };
      }

      // --- Status Handlers ---
      if (name === 'chatgpt_get_status' || name === 'gemini_get_status' || name === 'kimi_get_status' || name === 'zai_get_status') {
        const provider: LLMProvider =
          name === 'gemini_get_status' ? 'gemini' : name === 'kimi_get_status' ? 'kimi' : name === 'zai_get_status' ? 'zai' : 'chatgpt';
        const status = await client.getStatus(provider);
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
      }

      // --- Other ChatGPT specific tools ---
      if (name === 'chatgpt_reload') {
        const result = await client.reloadPage();
        return { content: [{ type: 'text', text: result.message || 'Page reloaded successfully.' }] };
      }

      if (name === 'chatgpt_get_latest_response') {
        const conversationId = args?.conversation_id ? String(args.conversation_id) : undefined;
        const refreshFirst = args?.refresh_first !== undefined ? Boolean(args.refresh_first) : true;
        const response = await client.getLatestResponse(conversationId, refreshFirst);
        return { content: formatChatResponse(response) };
      }

      if (name === 'chatgpt_list_conversations') {
        const limit = typeof args?.limit === 'number' ? Number(args.limit) : 30;
        const conversations = await client.listConversations(limit);
        return { content: [{ type: 'text', text: JSON.stringify(conversations, null, 2) }] };
      }

      if (name === 'chatgpt_list_models') {
        const models = await client.listModels();
        return { content: [{ type: 'text', text: JSON.stringify(models, null, 2) }] };
      }

      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error executing ${name}: ${err?.message || String(err)}` }],
        isError: true,
      };
    }
  });

  let closeTransport: (() => Promise<void>) | undefined;
  let closeHttpServer: (() => Promise<void>) | undefined;

  if (options.http) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
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
        res.end(JSON.stringify({ ok: true, service: 'mcp-web-llms', endpoint: '/mcp' }));
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
  console.error('Fatal error in mcp-web-llms server:', err);
  process.exit(1);
});
