import type { Page } from 'playwright';
import type { ChatOptions, ChatResponse, LLMStatus } from '../types.js';
import type { ProviderDriver } from './base-driver.js';

export class KimiDriver implements ProviderDriver {
  public readonly provider = 'kimi' as const;
  public readonly defaultUrl = 'https://www.kimi.ai/';

  public async ensurePage(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (!currentUrl.includes('kimi.ai')) {
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

    const hasInput = (await page.$('.chat-input-editor, div[contenteditable="true"], textarea, div[class*="editor"]')) !== null;
    const hasLoginModal = (await page.$('button[class*="login"], div[class*="login-dialog"], div[class*="auth-modal"]')) !== null;
    const isLoggedIn = hasInput && !hasLoginModal;

    return {
      provider: this.provider,
      isInitialized: true,
      isLoggedIn,
      currentUrl,
      title,
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
        : `https://www.kimi.ai/chat/${options.conversationId}`;
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

    const inputEl = await page.waitForSelector(
      '.chat-input-editor, div[contenteditable="true"], div[class*="editor"], textarea',
      { timeout: 15_000 }
    ).catch(() => null);

    if (!inputEl) {
      const status = await this.getStatus(page);
      if (!status.isLoggedIn) {
        throw new Error('Kimi AI is not logged in. Please log in first in your browser.');
      }
      throw new Error('Could not find prompt input on Kimi AI page.');
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

    const prevResponsesCount = await page.$$eval(
      'div[class*="segment-assistant"], div[class*="chat-item-assistant"], div[data-role="assistant"], div[class*="message-assistant"], .markdown',
      (els) => els.length
    );

    // Focus editor element
    await inputEl.click();
    await page.waitForTimeout(200);

    // Use insertText on active element
    await page.keyboard.insertText(options.message);
    await page.waitForTimeout(400);

    const sendBtn = await page.$(
      '.send-button-container:not(.disabled), div[class*="send-button"]:not(.disabled), button[class*="send"], svg.send-icon'
    );

    if (sendBtn) {
      await sendBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    const responseData = await this.waitForAssistantResponse(
      page,
      prevResponsesCount,
      options.timeoutMs || 120_000
    );

    const finalUrl = page.url();
    let conversationId: string | undefined;
    const match = finalUrl.match(/\/chat\/([a-zA-Z0-9_-]+)/);
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
        'button[class*="stop"], div[class*="stop"], svg[class*="stop"], div[class*="stop-button"]'
      );

      if (stopButton) {
        hasStartedGenerating = true;
      }

      const responseElements = await page.$$(
        'div[class*="segment-assistant"], div[class*="chat-item-assistant"], div[data-role="assistant"], div[class*="message-assistant"], .markdown'
      );

      if (responseElements.length > previousCount || (hasStartedGenerating && responseElements.length > 0)) {
        hasStartedGenerating = true;
        const lastEl = responseElements[responseElements.length - 1];

        const text = await lastEl.evaluate((el) => {
          const content = el.querySelector('.markdown') || el.querySelector('[class*="content"]') || el;
          return (content as HTMLElement).innerText.trim();
        });

        if (text.length > 0) {
          if (text === lastText) {
            stableCount++;
          } else {
            stableCount = 0;
            lastText = text;
          }

          if ((!stopButton && hasStartedGenerating && stableCount >= 2) || stableCount >= 4) {
            codes = await lastEl.$$eval('pre code, pre', (els) =>
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

    throw new Error(`Timeout waiting for Kimi response after ${Math.round(timeoutMs / 1000)} seconds.`);
  }
}
