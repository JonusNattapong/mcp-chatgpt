import type { LLMProvider } from '../types.js';
import type { ProviderDriver } from './base-driver.js';
import { ChatGPTDriver } from './chatgpt-driver.js';
import { GeminiDriver } from './gemini-driver.js';
import { KimiDriver } from './kimi-driver.js';
import { ZaiDriver } from './zai-driver.js';

export * from './base-driver.js';
export * from './chatgpt-driver.js';
export * from './gemini-driver.js';
export * from './kimi-driver.js';
export * from './zai-driver.js';

export class DriverManager {
  private static drivers: Map<LLMProvider, ProviderDriver> = new Map<LLMProvider, ProviderDriver>([
    ['chatgpt', new ChatGPTDriver() as ProviderDriver],
    ['gemini', new GeminiDriver() as ProviderDriver],
    ['kimi', new KimiDriver() as ProviderDriver],
    ['zai', new ZaiDriver() as ProviderDriver],
  ]);

  public static getDriver(provider: LLMProvider = 'chatgpt'): ProviderDriver {
    const driver = this.drivers.get(provider);
    if (!driver) {
      throw new Error(`Unsupported LLM provider: "${provider}". Supported providers: ${Array.from(this.drivers.keys()).join(', ')}`);
    }
    return driver;
  }
}
