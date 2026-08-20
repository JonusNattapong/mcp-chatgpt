export interface ChromeProfileInfo {
  id: string; // e.g. "Default", "Profile 1"
  name: string; // e.g. "Work", "Personal", or Google account name
  email?: string; // e.g. "user@example.com"
  path: string; // Full absolute path to profile directory
  avatarUrl?: string;
  isCurrent?: boolean;
}

export interface ChatGPTConfig {
  userDataDir?: string;
  headless?: boolean;
  cdpEndpoint?: string;
  timeoutMs?: number;
  browserExecutablePath?: string;
  useChrome?: boolean;
  selectedProfile?: string;
  bridgePort?: number;
}

export interface ChatOptions {
  message: string;
  newChat?: boolean;
  conversationId?: string;
  model?: string; // e.g. "gpt-4o", "o3-mini", "o1"
  profile?: string; // e.g. "Profile 1", "Work"
  webSearch?: boolean; // Enable live Web Search
  reasoningEffort?: 'low' | 'medium' | 'high'; // For o-series models
  imagePaths?: string[]; // Absolute paths to image files to upload
  filePaths?: string[]; // Absolute paths to documents/code files to upload
  autoContinue?: boolean; // Auto click "Continue generating" if response is cut off (default true)
  extractCodeOnly?: boolean; // If true, return only extracted code snippets
  timeoutMs?: number;
}

export interface ChatResponse {
  content: string;
  extractedCode?: string[];
  conversationId?: string;
  conversationUrl?: string;
  model?: string;
  profileUsed?: string;
  webSearchUsed?: boolean;
}

export interface ChatGPTStatus {
  isInitialized: boolean;
  isLoggedIn: boolean;
  currentUrl: string;
  title: string;
  model?: string;
  activeProfile?: string;
  bridgeConnected?: boolean;
}

export interface ConversationHistoryItem {
  id: string;
  title: string;
  url: string;
}

