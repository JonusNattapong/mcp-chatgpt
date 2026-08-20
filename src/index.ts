#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { program } from 'commander';
import { ChatGPTClient } from './chatgpt-client.js';
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
          timeoutMs,
        });

        const contents: any[] = [
          {
            type: 'text',
            text: response.content,
          },
        ];

        let metaText = `\n\n---\n*Profile:* ${response.profileUsed || 'Default'} | *Conversation URL:* ${response.conversationUrl || 'https://chatgpt.com'}`;
        if (response.webSearchUsed) metaText += ' | *Web Search:* Enabled 🌐';

        contents.push({
          type: 'text',
          text: metaText,
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

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const cleanup = async () => {
    await client.close();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('Fatal error in mcp-chatgpt server:', err);
  process.exit(1);
});
