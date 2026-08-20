import type { Page } from 'playwright';
import type { ChatOptions, ChatResponse, LLMStatus } from '../types.js';
import type { ProviderDriver } from './base-driver.js';

export class GeminiDriver implements ProviderDriver {
  public readonly provider = 'gemini' as const;
  public readonly defaultUrl = 'https://gemini.google.com/app';

  public async ensurePage(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (!currentUrl.includes('gemini.google.com')) {
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

    const hasInput = (await page.$('rich-textarea, div[contenteditable="true"], textarea')) !== null;
    const hasSignIn = (await page.$('a[href*="accounts.google.com"], button[aria-label*="Sign in"]')) !== null;
    const isLoggedIn = hasInput && !hasSignIn && !currentUrl.includes('accounts.google.com');

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
        : `https://gemini.google.com/app/${options.conversationId}`;
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
      'rich-textarea div[contenteditable="true"], div[contenteditable="true"], textarea',
      { timeout: 15_000 }
    ).catch(() => null);

    if (!inputEl) {
      const status = await this.getStatus(page);
      if (!status.isLoggedIn) {
        throw new Error('Google Gemini is not logged in. Please log in first with your Google account.');
      }
      throw new Error('Could not find prompt input on Gemini web page.');
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
      'model-response, message-content, .response-container-content',
      (els) => els.length
    );

    // Focus and fill text
    await inputEl.click();
    await page.waitForTimeout(200);

    // Use evaluate to safely insert into contenteditable
    await page.evaluate(({ selector, text }) => {
      const el = document.querySelector(selector) as HTMLElement;
      if (el) {
        el.focus();
        el.innerText = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      }
    }, {
      selector: 'rich-textarea div[contenteditable="true"], div[contenteditable="true"]',
      text: options.message,
    }).catch(async () => {
      await inputEl.fill(options.message);
    });

    await page.waitForTimeout(300);

    const sendBtn = await page.$(
      'button[aria-label*="Send prompt"], button[aria-label*="Send"], button[aria-label*="ส่ง"], button.send-button, button[mattooltip*="Send"]'
    );

    if (sendBtn && (await sendBtn.isEnabled())) {
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
    const match = finalUrl.match(/\/app\/([a-zA-Z0-9_-]+)/);
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
        'button[aria-label*="Stop"], button[aria-label*="หยุด"], mat-progress-spinner, .streaming'
      );

      if (stopButton) {
        hasStartedGenerating = true;
      }

      const responseElements = await page.$$(
        'model-response, message-content, .response-container-content, .model-response-text'
      );

      if (responseElements.length > previousCount) {
        hasStartedGenerating = true;
        const lastEl = responseElements[responseElements.length - 1];

        const text = await lastEl.evaluate((el) => {
          const content = el.querySelector('.markdown') || el.querySelector('.message-content') || el;
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

    throw new Error(`Timeout waiting for Gemini response after ${Math.round(timeoutMs / 1000)} seconds.`);
  }
}
