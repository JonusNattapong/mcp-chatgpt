import { chromium, type BrowserContext, type Page } from 'playwright';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type {
  WebLLMConfig,
  ChatOptions,
  ChatResponse,
  LLMStatus,
  LLMProvider,
  ChromeProfileInfo,
  ConversationHistoryItem,
  ModelsInfo,
} from './types.js';
import { ProfileManager } from './profile-manager.js';
import { ExtensionBridgeServer } from './bridge-server.js';
import { DriverManager } from './drivers/index.js';

export class ChatGPTClient {
  private config: WebLLMConfig;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isBusy = false;
  private bridgeServer: ExtensionBridgeServer;
  private selectedProfile: ChromeProfileInfo | null = null;

  constructor(config: WebLLMConfig = {}) {
    const defaultDataDir = path.join(os.homedir(), '.mcp-chatgpt', 'browser-data');
    this.config = {
      userDataDir: config.userDataDir || process.env.CHATGPT_USER_DATA_DIR || defaultDataDir,
      headless: config.headless ?? (process.env.CHATGPT_HEADLESS !== 'false'),
      cdpEndpoint: config.cdpEndpoint || process.env.CHATGPT_CDP_ENDPOINT,
      timeoutMs: config.timeoutMs || 120_000,
      browserExecutablePath: config.browserExecutablePath || process.env.CHATGPT_BROWSER_PATH,
      useChrome: config.useChrome ?? true,
      selectedProfile: config.selectedProfile || process.env.CHATGPT_PROFILE,
      bridgePort: config.bridgePort || (process.env.CHATGPT_BRIDGE_PORT ? parseInt(process.env.CHATGPT_BRIDGE_PORT, 10) : 18999),
    };

    this.bridgeServer = new ExtensionBridgeServer(this.config.bridgePort);
    this.bridgeServer.start().catch((err) => {
      console.warn('Failed to start ExtensionBridgeServer:', err);
    });

    if (this.config.selectedProfile) {
      this.selectedProfile = ProfileManager.findProfile(this.config.selectedProfile);
    }
  }

  public listProfiles(): ChromeProfileInfo[] {
    const profiles = ProfileManager.listProfiles();
    return profiles.map((p) => ({
      ...p,
      isCurrent: this.selectedProfile?.id === p.id,
    }));
  }

  public selectProfile(identifier: string): ChromeProfileInfo {
    const found = ProfileManager.findProfile(identifier);
    if (!found) {
      const available = ProfileManager.listProfiles()
        .map((p) => `"${p.id}" (${p.name}${p.email ? ` - ${p.email}` : ''})`)
        .join(', ');
      throw new Error(
        `Chrome profile "${identifier}" not found. Available profiles: ${available}`
      );
    }

    this.selectedProfile = found;
    // Reset existing playwright context so next call re-opens with new profile
    if (this.context) {
      this.close();
    }
    return found;
  }

  public getSelectedProfile(): ChromeProfileInfo | null {
    return this.selectedProfile;
  }

  public async initialize(options: { headed?: boolean; profile?: string; provider?: LLMProvider } = {}): Promise<void> {
    if (options.profile) {
      this.selectProfile(options.profile);
    }

    if (this.context && this.page && !this.page.isClosed()) {
      return;
    }

    const isHeadless = options.headed !== undefined ? !options.headed : this.config.headless;

    if (this.config.cdpEndpoint) {
      const browser = await chromium.connectOverCDP(this.config.cdpEndpoint);
      const contexts = browser.contexts();
      this.context = contexts.length > 0 ? contexts[0] : await browser.newContext();
      const pages = this.context.pages();
      this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    } else {
      let dataDir = this.config.userDataDir!;

      if (this.selectedProfile) {
        dataDir = ProfileManager.getProfileIsolatedDir(this.selectedProfile.id);
      }

      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const launchOptions: any = {
        headless: isHeadless,
        viewport: { width: 1280, height: 800 },
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
      };

      if (this.config.browserExecutablePath) {
        launchOptions.executablePath = this.config.browserExecutablePath;
      } else if (this.config.useChrome) {
        launchOptions.channel = 'chrome';
      }

      try {
        this.context = await chromium.launchPersistentContext(dataDir, launchOptions);
      } catch (err: any) {
        if (launchOptions.channel) {
          delete launchOptions.channel;
          this.context = await chromium.launchPersistentContext(dataDir, launchOptions);
        } else {
          throw err;
        }
      }

      const pages = this.context.pages();
      this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    }

    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    const driver = DriverManager.getDriver(options.provider || 'chatgpt');
    await driver.ensurePage(this.page);
  }

  public async getStatus(provider: LLMProvider = 'chatgpt'): Promise<LLMStatus> {
    let isBridgeConnected = this.bridgeServer.isConnected();
    let bridgeProfile = this.bridgeServer.getConnectedProfileName();

    if (!isBridgeConnected) {
      const remote = await this.bridgeServer.checkRemoteStatus();
      if (remote.connected) {
        isBridgeConnected = true;
        bridgeProfile = remote.profileName || 'Chrome Extension';
      }
    }

    if (isBridgeConnected) {
      return {
        provider,
        isInitialized: true,
        isLoggedIn: true,
        currentUrl: `${provider} (via Chrome Extension)`,
        title: `${provider} Web (Extension Bridge)`,
        activeProfile: bridgeProfile || 'Chrome Extension',
        bridgeConnected: true,
      };
    }

    if (!this.page || this.page.isClosed()) {
      return {
        provider,
        isInitialized: false,
        isLoggedIn: false,
        currentUrl: '',
        title: '',
        activeProfile: this.selectedProfile ? `${this.selectedProfile.name} (${this.selectedProfile.id})` : undefined,
        bridgeConnected: false,
      };
    }

    const driver = DriverManager.getDriver(provider);
    const status = await driver.getStatus(this.page);
    status.activeProfile = this.selectedProfile ? `${this.selectedProfile.name} (${this.selectedProfile.id})` : undefined;
    return status;
  }

  public async newChat(provider: LLMProvider = 'chatgpt'): Promise<{ success: boolean; url: string }> {
    const remote = await this.bridgeServer.checkRemoteStatus();
    if (this.bridgeServer.isConnected() || remote.connected) {
      return {
        success: true,
        url: provider === 'chatgpt' ? 'https://chatgpt.com' : provider === 'gemini' ? 'https://gemini.google.com/app' : provider === 'kimi' ? 'https://www.kimi.ai/' : 'https://chat.z.ai/',
      };
    }

    await this.initialize({ provider });
    if (!this.page) throw new Error('Failed to initialize page');

    const driver = DriverManager.getDriver(provider);
    return await driver.newChat(this.page);
  }

  public async getLatestResponse(conversationId?: string, refreshFirst = true): Promise<ChatResponse> {
    const remote = await this.bridgeServer.checkRemoteStatus();
    if (this.bridgeServer.isConnected() || remote.connected) {
      return this.bridgeServer.getLatestResponse(conversationId, refreshFirst);
    }

    throw new Error('Chrome Extension is not connected.');
  }

  public async reloadPage(): Promise<{ success: boolean; message: string }> {
    const remote = await this.bridgeServer.checkRemoteStatus();
    if (this.bridgeServer.isConnected() || remote.connected) {
      return this.bridgeServer.reloadPage();
    }

    await this.initialize();
    if (!this.page) throw new Error('Browser is not initialized');
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    return { success: true, message: 'Page reloaded' };
  }

  public async listModels(): Promise<ModelsInfo> {
    const remote = await this.bridgeServer.checkRemoteStatus();
    if (this.bridgeServer.isConnected() || remote.connected) {
      return this.bridgeServer.listModels();
    }

    return { models: ['GPT-5.6 Sol', 'GPT-5.5', 'o3', 'gpt-4o', 'o1'], currentModel: 'Default' };
  }

  public async listConversations(limit: number = 30): Promise<ConversationHistoryItem[]> {
    const remote = await this.bridgeServer.checkRemoteStatus();
    if (this.bridgeServer.isConnected() || remote.connected) {
      return this.bridgeServer.listConversations(limit);
    }

    await this.initialize();
    if (!this.page) throw new Error('Failed to initialize page');

    return this.page.evaluate((maxItems) => {
      const items: any[] = [];
      const links = Array.from(
        document.querySelectorAll('nav a[href*="/c/"], a[href^="/c/"], [data-testid^="history-item"]')
      );

      for (const a of links) {
        const href = a.getAttribute('href') || a.querySelector('a')?.getAttribute('href') || '';
        const match = href.match(/\/c\/([a-zA-Z0-9-]+)/);
        if (!match) continue;

        const convId = match[1];
        if (items.some((it) => it.id === convId)) continue;

        const titleEl = a.querySelector('div.relative') || a.querySelector('div') || a;
        let title = (titleEl.textContent || '').trim().split('\n')[0].trim();

        if (title && !title.includes('New chat') && !title.includes('แชทใหม่')) {
          items.push({
            id: convId,
            title,
            url: `https://chatgpt.com/c/${convId}`,
          });
        }

        if (items.length >= maxItems) break;
      }

      return items;
    }, limit);
  }

  public async ask(options: ChatOptions): Promise<ChatResponse> {
    const provider = options.provider || 'chatgpt';

    if (options.profile) {
      this.selectProfile(options.profile);
    }

    // 1. Check Chrome Extension Bridge first
    let isBridgeActive = !options.disableBridge && this.bridgeServer.isConnected();
    if (!options.disableBridge && !isBridgeActive) {
      const remote = await this.bridgeServer.checkRemoteStatus();
      isBridgeActive = remote.connected;
    }

    if (isBridgeActive) {
      return await this.bridgeServer.ask(options);
    }

    // 2. Automate via Playwright Persistent Browser
    if (this.isBusy) {
      throw new Error(`LLM client is currently busy processing another request.`);
    }

    this.isBusy = true;
    try {
      await this.initialize({ provider });
      if (!this.page) throw new Error('Failed to initialize page');

      const driver = DriverManager.getDriver(provider);
      const response = await driver.sendMessage(this.page, options);
      response.profileUsed = this.selectedProfile
        ? `${this.selectedProfile.name} (${this.selectedProfile.id})`
        : 'Default Profile';
      return response;
    } finally {
      this.isBusy = false;
    }
  }

  public async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
    }
    await this.bridgeServer.stop();
  }
}
