import type { Page } from 'playwright';
import type { ChatOptions, ChatResponse, LLMStatus } from '../types.js';
import type { ProviderDriver } from './base-driver.js';

export class ZaiDriver implements ProviderDriver {
  public readonly provider = 'zai' as const;
  public readonly defaultUrl = 'https://chat.z.ai/';

  public async ensurePage(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (!currentUrl.includes('z.ai')) {
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

    const hasInput = (await page.$('textarea#chat-input, textarea, div[contenteditable="true"]')) !== null;
    const hasLoginModal = (await page.$('button[class*="login"], a[href*="login"]')) !== null;
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
        : `https://chat.z.ai/c/${options.conversationId}`;
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
      'textarea#chat-input, textarea, div[contenteditable="true"]',
      { timeout: 15_000 }
    ).catch(() => null);

    if (!inputEl) {
      const status = await this.getStatus(page);
      if (!status.isLoggedIn) {
        throw new Error('Z.ai is not logged in. Please log in first in your browser.');
      }
      throw new Error('Could not find prompt input on Z.ai page.');
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
      '.markdown-body, div[class*="assistant"], div[class*="message"], div[class*="content"]',
      (els) => els.length
    );

    // Focus and type text
    await inputEl.click();
    await page.waitForTimeout(200);

    await page.keyboard.type(options.message, { delay: 15 });
    await page.waitForTimeout(300);

    try {
      await page.click('.sendMessageButton, button[type="submit"]');
    } catch {
      await page.keyboard.press('Enter');
    }

    const responseData = await this.waitForAssistantResponse(
      page,
      prevResponsesCount,
      options.timeoutMs || 120_000
    );

    const finalUrl = page.url();
    let conversationId: string | undefined;
    const match = finalUrl.match(/\/c\/([a-zA-Z0-9_-]+)/);
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

      const isThinkingOrStreaming = await page.evaluate(() => {
        const stopBtn = document.querySelector('button[class*="stop"], div[class*="stop"], .sendMessageButton svg path[d*="rect"], svg rect');
        const buttons = Array.from(document.querySelectorAll('button, div'));
        const hasSkip = buttons.some((b) => (b.textContent || '').includes('Skip') || (b.textContent || '').includes('Thinking...'));
        return !!stopBtn || hasSkip;
      });

      if (isThinkingOrStreaming) {
        hasStartedGenerating = true;
      }

      const responseElements = await page.$$(
        '.markdown-body, .prose, div[class*="assistant"], div[class*="message"]:not([class*="user"])'
      );

      if (responseElements.length > previousCount || (hasStartedGenerating && responseElements.length > 0)) {
        hasStartedGenerating = true;
        const lastEl = responseElements[responseElements.length - 1];

        const text = await lastEl.evaluate((el) => {
          const content = el.querySelector('.markdown-body') || el.querySelector('.prose') || el.querySelector('.markdown') || el;
          return (content as HTMLElement).innerText.replace(/^Thinking\.\.\..*?Skip\s*/s, '').trim();
        });

        if (text.length > 0) {
          if (text === lastText) {
            stableCount++;
          } else {
            stableCount = 0;
            lastText = text;
          }

          if ((!isThinkingOrStreaming && hasStartedGenerating && stableCount >= 2) || stableCount >= 5) {
            codes = await lastEl.$$eval('pre code, pre', (els) =>
              els.map((e) => e.textContent?.trim() || '').filter(Boolean)
            );
            return { text: lastText, codes };
          }
        }
      } else if (hasStartedGenerating && !isThinkingOrStreaming) {
        if (lastText.length > 0) {
          return { text: lastText, codes };
        }
      }
    }

    if (lastText.length > 0) {
      return { text: lastText, codes };
    }

    throw new Error(`Timeout waiting for Z.ai response after ${Math.round(timeoutMs / 1000)} seconds.`);
  }
}
