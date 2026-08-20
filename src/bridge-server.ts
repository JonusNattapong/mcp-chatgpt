import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'node:http';
import type { ChatOptions, ChatResponse, ConversationHistoryItem } from './types.js';

interface PendingRequest {
  resolve: (res: any) => void;
  reject: (err: Error) => void;
  timeoutTimer: NodeJS.Timeout;
}

export class ExtensionBridgeServer {
  private wss: WebSocketServer | null = null;
  private server: http.Server | null = null;
  private activeWs: WebSocket | null = null;
  private profileName: string | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private port: number;
  private isServerOwner = false;

  constructor(port = 18999) {
    this.port = port;
  }

  public async start(): Promise<void> {
    if (this.server) return;

    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        if (req.url === '/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              connected: this.isConnected(),
              profileName: this.profileName,
            })
          );
          return;
        }

        if (req.url?.startsWith('/conversations') && req.method === 'GET') {
          try {
            const parsedUrl = new URL(req.url, 'http://127.0.0.1');
            const limit = parseInt(parsedUrl.searchParams.get('limit') || '30', 10);
            const conversations = await this.listConversationsDirect(limit);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ conversations }));
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err?.message || String(err) }));
          }
          return;
        }

        if (req.url === '/ask' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', async () => {
            try {
              const options: ChatOptions = JSON.parse(body);
              const result = await this.askDirect(options);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (err: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err?.message || String(err) }));
            }
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.server.on('error', (err: any) => {
        // Port is already in use by another instance of bridge server
        this.isServerOwner = false;
        resolve();
      });

      this.wss = new WebSocketServer({ noServer: true });

      this.wss.on('connection', (ws: WebSocket) => {
        this.activeWs = ws;

        ws.on('message', (data: string) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (e) {
            // ignore non-json
          }
        });

        ws.on('close', () => {
          if (this.activeWs === ws) {
            this.activeWs = null;
            this.profileName = null;
          }
        });

        ws.on('error', () => {
          if (this.activeWs === ws) {
            this.activeWs = null;
          }
        });
      });

      this.server.on('upgrade', (request, socket, head) => {
        if (this.wss) {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss?.emit('connection', ws, request);
          });
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.isServerOwner = true;
        resolve();
      });
    });
  }

  private handleMessage(message: any) {
    if (message.action === 'ping') {
      if (this.activeWs && this.activeWs.readyState === WebSocket.OPEN) {
        this.activeWs.send(JSON.stringify({ action: 'pong' }));
      }
      return;
    }

    if (message.action === 'register') {
      this.profileName = message.profileName || 'Chrome Extension Profile';
      return;
    }

    if (message.action === 'response' && message.id) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeoutTimer);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(message.error));
        } else if (message.conversations) {
          pending.resolve(message.conversations);
        } else {
          pending.resolve({
            content: message.content || '',
            conversationUrl: message.conversationUrl,
            conversationId: message.conversationId,
            profileUsed: this.profileName || 'Chrome Extension',
          });
        }
      }
    }
  }

  public async listConversations(limit: number = 30): Promise<ConversationHistoryItem[]> {
    if (this.isConnected()) {
      return this.listConversationsDirect(limit);
    }

    if (!this.isServerOwner) {
      const remoteStatus = await this.checkRemoteStatus();
      if (remoteStatus.connected) {
        const res = await fetch(`http://127.0.0.1:${this.port}/conversations?limit=${limit}`);
        const data: any = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || 'Bridge request failed');
        }
        return data.conversations || [];
      }
    }

    return [];
  }

  private async listConversationsDirect(limit: number = 30): Promise<ConversationHistoryItem[]> {
    if (!this.isConnected()) {
      throw new Error('Chrome Extension is not connected.');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    return new Promise((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Timeout waiting for conversations list from Chrome Extension'));
      }, 15000);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutTimer,
      });

      this.activeWs?.send(
        JSON.stringify({
          action: 'list_conversations',
          id: requestId,
          limit,
        })
      );
    });
  }

  public isConnected(): boolean {
    return this.activeWs !== null && this.activeWs.readyState === WebSocket.OPEN;
  }

  public async checkRemoteStatus(): Promise<{ connected: boolean; profileName?: string }> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/status`);
      if (res.ok) {
        return (await res.json()) as any;
      }
    } catch {
      // not reachable
    }
    return { connected: false };
  }

  public getConnectedProfileName(): string | null {
    return this.profileName;
  }

  public async ask(options: ChatOptions): Promise<ChatResponse> {
    if (this.isConnected()) {
      return this.askDirect(options);
    }

    // If we are not the server owner, try delegating to the running server via HTTP
    if (!this.isServerOwner) {
      const remoteStatus = await this.checkRemoteStatus();
      if (remoteStatus.connected) {
        const res = await fetch(`http://127.0.0.1:${this.port}/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options),
        });

        const data: any = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || 'Bridge request failed');
        }
        return data;
      }
    }

    throw new Error('Chrome Extension is not connected.');
  }

  private async askDirect(options: ChatOptions): Promise<ChatResponse> {
    if (!this.isConnected()) {
      throw new Error('Chrome Extension is not connected.');
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const timeoutMs = options.timeoutMs || 120_000;

    return new Promise((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new Error(
            `Timeout waiting for response from Chrome Extension after ${Math.round(timeoutMs / 1000)}s`
          )
        );
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutTimer,
      });

      this.activeWs!.send(
        JSON.stringify({
          action: 'ask',
          id: requestId,
          message: options.message,
          newChat: options.newChat,
          conversationId: options.conversationId,
        })
      );
    });
  }

  public async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.activeWs = null;
  }
}
