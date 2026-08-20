import type { Page } from 'playwright';
import type { ChatOptions, ChatResponse, LLMProvider, LLMStatus } from '../types.js';

export interface ProviderDriver {
  readonly provider: LLMProvider;
  readonly defaultUrl: string;

  ensurePage(page: Page): Promise<void>;
  getStatus(page: Page | null): Promise<LLMStatus>;
  newChat(page: Page): Promise<{ success: boolean; url: string }>;
  sendMessage(page: Page, options: ChatOptions): Promise<ChatResponse>;
}
