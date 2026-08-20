import { chromium, type BrowserContext, type Page } from 'playwright';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type {
  ChatGPTConfig,
  ChatOptions,
  ChatResponse,
  ChatGPTStatus,
  ChromeProfileInfo,
  ConversationHistoryItem,
  ModelsInfo,
} from './types.js';
import { ProfileManager } from './profile-manager.js';
import { ExtensionBridgeServer } from './bridge-server.js';

export class ChatGPTClient {
  private config: ChatGPTConfig;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isBusy = false;
  private bridgeServer: ExtensionBridgeServer;
  private selectedProfile: ChromeProfileInfo | null = null;

  constructor(config: ChatGPTConfig = {}) {
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

  public async initialize(options: { headed?: boolean; profile?: string } = {}): Promise<void> {
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

      // If a Chrome profile is selected, use dedicated profile directory
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
        // If system chrome fails or is locked, retry with standard chromium
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

    await this.ensureChatGPTPage();
  }

  private async ensureChatGPTPage(): Promise<void> {
    if (!this.page) throw new Error('Browser page is not initialized');

    const currentUrl = this.page.url();
    if (!currentUrl.includes('chatgpt.com')) {
      await this.page.goto('https://chatgpt.com', {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await this.page.waitForTimeout(2000);
    }
  }

  public async getStatus(): Promise<ChatGPTStatus> {
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
        isInitialized: true,
        isLoggedIn: true,
        currentUrl: 'https://chatgpt.com (via Chrome Extension)',
        title: 'ChatGPT Web (Extension Bridge)',
        activeProfile: bridgeProfile || 'Chrome Extension',
        bridgeConnected: true,
      };
    }

    if (!this.page || this.page.isClosed()) {
      return {
        isInitialized: false,
        isLoggedIn: false,
        currentUrl: '',
        title: '',
        activeProfile: this.selectedProfile ? `${this.selectedProfile.name} (${this.selectedProfile.id})` : undefined,
        bridgeConnected: false,
      };
    }

    const currentUrl = this.page.url();
    const title = await this.page.title();

    const hasPromptTextarea = (await this.page.$('#prompt-textarea')) !== null;
    const hasLoginButton = (await this.page.$('button[data-testid="login-button"], a[href*="/auth/login"]')) !== null;
    const isLoggedIn = hasPromptTextarea || (!hasLoginButton && !currentUrl.includes('/auth/login'));

    let currentModel: string | undefined;
    try {
      const modelButton = await this.page.$('button[data-testid="model-switcher-dropdown-button"]');
      if (modelButton) {
        currentModel = (await modelButton.innerText()).trim();
      }
    } catch {
      // ignore
    }

    return {
      isInitialized: true,
      isLoggedIn,
      currentUrl,
      title,
      model: currentModel,
      activeProfile: this.selectedProfile ? `${this.selectedProfile.name} (${this.selectedProfile.id})` : undefined,
      bridgeConnected: false,
    };
  }

  public async newChat(): Promise<{ success: boolean; url: string }> {
    const remote = await this.bridgeServer.checkRemoteStatus();
    if (this.bridgeServer.isConnected() || remote.connected) {
      return {
        success: true,
        url: 'https://chatgpt.com',
      };
    }

    await this.initialize();
    if (!this.page) throw new Error('Failed to initialize page');

    await this.page.goto('https://chatgpt.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await this.page.waitForTimeout(1500);

    return {
      success: true,
      url: this.page.url(),
    };
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
    if (options.profile) {
      this.selectProfile(options.profile);
    }

    // 1. If Extension Bridge is connected (local or remote daemon), prioritize sending via active Chrome tab
    let isBridgeActive = this.bridgeServer.isConnected();
    if (!isBridgeActive) {
      const remote = await this.bridgeServer.checkRemoteStatus();
      isBridgeActive = remote.connected;
    }

    if (isBridgeActive) {
      return await this.bridgeServer.ask(options);
    }

    // 2. Otherwise automate via Playwright Persistent Browser
    if (this.isBusy) {
      throw new Error('ChatGPT client is currently busy processing another request.');
    }

    this.isBusy = true;
    try {
      await this.initialize();
      if (!this.page) throw new Error('Failed to initialize page');

      if (options.conversationId) {
        const targetUrl = options.conversationId.startsWith('http')
          ? options.conversationId
          : `https://chatgpt.com/c/${options.conversationId}`;
        if (this.page.url() !== targetUrl) {
          await this.page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
          await this.page.waitForTimeout(1500);
        }
      } else if (options.newChat) {
        await this.newChat();
      } else {
        await this.ensureChatGPTPage();
      }

      const textarea = await this.page.waitForSelector('#prompt-textarea', {
        timeout: 15_000,
      }).catch(() => null);

      if (!textarea) {
        const status = await this.getStatus();
        if (!status.isLoggedIn) {
          throw new Error(
            'ChatGPT Web is not logged in or prompt textarea is unavailable. Please run login mode first or install the Chrome Extension.'
          );
        }
        throw new Error('Could not find #prompt-textarea on ChatGPT web page.');
      }

      // If files/images provided, upload via file input
      const uploadFiles = [...(options.imagePaths || []), ...(options.filePaths || [])];
      if (uploadFiles.length > 0) {
        const fileInput = await this.page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.setInputFiles(uploadFiles);
          await this.page.waitForTimeout(1000);
        }
      }

      // If Web Search requested, click search button
      if (options.webSearch) {
        const searchBtn = await this.page.$(
          'button[aria-label*="Search"], button[aria-label*="ค้นหา"], button[data-testid="search-web-button"]'
        );
        if (searchBtn) {
          await searchBtn.click();
          await this.page.waitForTimeout(300);
        }
      }

      const prevAssistantMessagesCount = await this.page.$$eval(
        '[data-message-author-role="assistant"]',
        (els) => els.length
      );

      await textarea.click();
      await this.page.waitForTimeout(200);

      await textarea.fill(options.message);
      await this.page.waitForTimeout(300);

      const sendButton = await this.page.$(
        'button[data-testid="send-button"], button[aria-label="Send prompt"]'
      );

      if (sendButton && (await sendButton.isEnabled())) {
        await sendButton.click();
      } else {
        await this.page.keyboard.press('Enter');
      }

      const responseData = await this.waitForAssistantResponse(
        prevAssistantMessagesCount,
        options.timeoutMs || this.config.timeoutMs || 120_000,
        options.autoContinue !== false
      );

      const finalUrl = this.page.url();
      let conversationId: string | undefined;
      const match = finalUrl.match(/\/c\/([a-zA-Z0-9-]+)/);
      if (match) {
        conversationId = match[1];
      }

      let content = responseData.text;
      if (options.extractCodeOnly && responseData.codes.length > 0) {
        content = responseData.codes.join('\n\n---\n\n');
      }

      return {
        content,
        extractedCode: responseData.codes.length > 0 ? responseData.codes : undefined,
        conversationId,
        conversationUrl: finalUrl,
        profileUsed: this.selectedProfile ? `${this.selectedProfile.name} (${this.selectedProfile.id})` : 'Default Profile',
        webSearchUsed: options.webSearch,
      };
    } finally {
      this.isBusy = false;
    }
  }

  private async waitForAssistantResponse(
    previousCount: number,
    timeoutMs: number,
    autoContinue = true
  ): Promise<{ text: string; codes: string[] }> {
    if (!this.page) throw new Error('Page is not initialized');

    const startTime = Date.now();
    const pollInterval = 600;
    let lastText = '';
    let stableCount = 0;
    let hasStartedGenerating = false;
    let codes: string[] = [];

    while (Date.now() - startTime < timeoutMs) {
      await this.page.waitForTimeout(pollInterval);

      const stopButton = await this.page.$(
        'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]'
      );

      if (stopButton) {
        hasStartedGenerating = true;
      }

      const assistantMessages = await this.page.$$(
        '[data-message-author-role="assistant"]'
      );

      if (assistantMessages.length > previousCount) {
        hasStartedGenerating = true;
        const lastMessageEl = assistantMessages[assistantMessages.length - 1];

        const text = await lastMessageEl.evaluate((el) => {
          const markdownEl = el.querySelector('.markdown') || el;
          return (markdownEl as HTMLElement).innerText.trim();
        });

        if (text.length > 0) {
          if (text === lastText) {
            stableCount++;
          } else {
            stableCount = 0;
            lastText = text;
          }

          if ((!stopButton && hasStartedGenerating && stableCount >= 2) || stableCount >= 4) {
            codes = await lastMessageEl.$$eval('pre code, pre', (els) =>
              els.map((e) => e.textContent?.trim() || '').filter(Boolean)
            );
            return { text: lastText, codes };
          }
        }
      } else if (hasStartedGenerating && !stopButton) {
        if (lastText.length > 0) {
          return { text: lastText, codes };
        }
      }
    }

    if (lastText.length > 0) {
      return { text: lastText, codes };
    }

    throw new Error(
      `Timeout waiting for ChatGPT response after ${Math.round(timeoutMs / 1000)} seconds.`
    );
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
