export type LLMProvider = 'chatgpt' | 'gemini' | 'kimi' | 'zai';

export interface ChromeProfileInfo {
  id: string; // e.g. "Default", "Profile 1"
  name: string; // e.g. "Work", "Personal", or Google account name
  email?: string; // e.g. "user@example.com"
  path: string; // Full absolute path to profile directory
  avatarUrl?: string;
  isCurrent?: boolean;
}

export interface WebLLMConfig {
  userDataDir?: string;
  headless?: boolean;
  cdpEndpoint?: string;
  timeoutMs?: number;
  browserExecutablePath?: string;
  useChrome?: boolean;
  selectedProfile?: string;
  bridgePort?: number;
}

// Backward compatibility alias
export type ChatGPTConfig = WebLLMConfig;

export interface ChatOptions {
  provider?: LLMProvider;
  message: string;
  newChat?: boolean;
  conversationId?: string;
  model?: string; // e.g. "gpt-4o", "gemini-2.0-flash", "kimi-k1", "glm-4"
  profile?: string; // e.g. "Profile 1", "Work"
  webSearch?: boolean; // Enable live Web Search if supported
  reasoningEffort?: 'low' | 'medium' | 'high'; // For reasoning models
  imagePaths?: string[]; // Absolute paths to image files to upload
  filePaths?: string[]; // Absolute paths to documents/code files to upload
  autoContinue?: boolean; // Auto click "Continue generating" if response is cut off (default true)
  extractCodeOnly?: boolean; // If true, return only extracted code snippets
  refreshPage?: boolean; // If true, reload the page before sending the message
  disableBridge?: boolean; // If true, force using Playwright driver instead of Chrome Extension
  timeoutMs?: number;
}

export interface ChatResponse {
  provider?: LLMProvider;
  content: string;
  extractedCode?: string[];
  imageUrls?: string[];
  images?: Array<{ url: string; alt?: string }>;
  conversationId?: string;
  conversationUrl?: string;
  model?: string;
  profileUsed?: string;
  webSearchUsed?: boolean;
}

export interface LLMStatus {
  provider: LLMProvider;
  isInitialized: boolean;
  isLoggedIn: boolean;
  currentUrl: string;
  title: string;
  model?: string;
  activeProfile?: string;
  bridgeConnected?: boolean;
}

// Backward compatibility alias
export type ChatGPTStatus = LLMStatus;

export interface ConversationHistoryItem {
  id: string;
  title: string;
  url: string;
}

export interface ModelsInfo {
  models: string[];
  currentModel?: string;
  reasoningEfforts?: string[];
}


