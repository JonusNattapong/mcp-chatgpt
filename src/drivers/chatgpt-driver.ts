import type { Page } from 'playwright';
import type { ChatOptions, ChatResponse, LLMStatus } from '../types.js';
import type { ProviderDriver } from './base-driver.js';

export class ChatGPTDriver implements ProviderDriver {
  public readonly provider = 'chatgpt' as const;
  public readonly defaultUrl = 'https://chatgpt.com';

  public async ensurePage(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (!currentUrl.includes('chatgpt.com')) {
      await page.goto(this.defaultUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await page.waitForTimeout(2000);
    }
  }

  public async getStatus(page: Page | null): Promise<LLMStatus> {
    if (!page || page.isClosed()) {
      return {
        provider: this.provider,
        isInitialized: false,
        isLoggedIn: false,
        currentUrl: '',
        title: '',
        bridgeConnected: false,
      };
    }

    const currentUrl = page.url();
    const title = await page.title().catch(() => '');

    const hasPromptTextarea = (await page.$('#prompt-textarea')) !== null;
    const hasLoginButton = (await page.$('button[data-testid="login-button"], a[href*="/auth/login"]')) !== null;
    const isLoggedIn = hasPromptTextarea || (!hasLoginButton && !currentUrl.includes('/auth/login'));

    let currentModel: string | undefined;
    try {
      const modelButton = await page.$('button[data-testid="model-switcher-dropdown-button"]');
      if (modelButton) {
        currentModel = (await modelButton.innerText()).trim();
      }
    } catch {
      // ignore
    }

    return {
      provider: this.provider,
      isInitialized: true,
      isLoggedIn,
      currentUrl,
      title,
      model: currentModel,
      bridgeConnected: false,
    };
  }

  public async newChat(page: Page): Promise<{ success: boolean; url: string }> {
    await page.goto(this.defaultUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await page.waitForTimeout(1500);
    return { success: true, url: page.url() };
  }

  public async sendMessage(page: Page, options: ChatOptions): Promise<ChatResponse> {
    if (options.conversationId) {
      const targetUrl = options.conversationId.startsWith('http')
        ? options.conversationId
        : `https://chatgpt.com/c/${options.conversationId}`;
      if (page.url() !== targetUrl) {
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        await page.waitForTimeout(1500);
      }
    } else if (options.newChat) {
      await this.newChat(page);
    } else {
      await this.ensurePage(page);
    }

    const textarea = await page.waitForSelector('#prompt-textarea, div[contenteditable="true"], textarea', {
      timeout: 15_000,
    }).catch(() => null);

    if (!textarea) {
      const status = await this.getStatus(page);
      if (!status.isLoggedIn) {
        throw new Error('ChatGPT Web is not logged in. Please log in first in your browser.');
      }
      throw new Error('Could not find prompt textarea on ChatGPT web page.');
    }

    // Attach files if provided
    const uploadFiles = [...(options.imagePaths || []), ...(options.filePaths || [])];
    if (uploadFiles.length > 0) {
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.setInputFiles(uploadFiles);
        await page.waitForTimeout(1000);
      }
    }

    // Web Search toggle
    if (options.webSearch) {
      const searchBtn = await page.$(
        'button[aria-label*="Search"], button[aria-label*="ค้นหา"], button[data-testid="search-web-button"]'
      );
      if (searchBtn) {
        await searchBtn.click();
        await page.waitForTimeout(300);
      }
    }

    const prevAssistantMessagesCount = await page.$$eval(
      '[data-message-author-role="assistant"]',
      (els) => els.length
    );

    await textarea.click();
    await page.waitForTimeout(200);
    await textarea.fill(options.message);
    await page.waitForTimeout(300);

    const sendButton = await page.$(
      'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="ส่งพร้อมท์"]'
    );

    if (sendButton && (await sendButton.isEnabled())) {
      await sendButton.click();
    } else {
      await page.keyboard.press('Enter');
    }

    const responseData = await this.waitForAssistantResponse(
      page,
      prevAssistantMessagesCount,
      options.timeoutMs || 120_000
    );

    const finalUrl = page.url();
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
      provider: this.provider,
      content,
      extractedCode: responseData.codes.length > 0 ? responseData.codes : undefined,
      conversationId,
      conversationUrl: finalUrl,
      webSearchUsed: options.webSearch,
    };
  }

  private async waitForAssistantResponse(
    page: Page,
    previousCount: number,
    timeoutMs: number
  ): Promise<{ text: string; codes: string[] }> {
    const startTime = Date.now();
    const pollInterval = 600;
    let lastText = '';
    let stableCount = 0;
    let hasStartedGenerating = false;
    let codes: string[] = [];

    while (Date.now() - startTime < timeoutMs) {
      await page.waitForTimeout(pollInterval);

      const stopButton = await page.$(
        'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label*="หยุด"]'
      );

      if (stopButton) {
        hasStartedGenerating = true;
      }

      const assistantMessages = await page.$$('[data-message-author-role="assistant"]');

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

    throw new Error(`Timeout waiting for ChatGPT response after ${Math.round(timeoutMs / 1000)} seconds.`);
  }
}
