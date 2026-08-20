# mcp-chatgpt

An MCP (Model Context Protocol) server that allows AI assistants (such as Google Antigravity, Claude Desktop, Cursor, VS Code Cline/Roo Code) to ask questions, chat, and interact with **ChatGPT Web** (`https://chatgpt.com`) directly through browser automation, Chrome Profiles, and a companion Chrome Extension.

---

## 🌟 Features

- 💬 **Ask & Chat**: Seamlessly ask questions to ChatGPT Web and receive responses (formatted text / markdown).
- 🌐 **Web Search Toggle**: Enable ChatGPT's live Web Search (`web_search: true`) for real-time web browsing and citations.
- 🧠 **Reasoning & Model Selection**: Select models (`model: "o3-mini"`, `"gpt-4o"`, `"o1"`) and configure reasoning effort (`reasoning_effort: "high" | "medium" | "low"`).
- 📎 **File & Image Attachments**: Attach images (`image_paths`) and documents/code (`file_paths`) for multimodal analysis.
- ⏩ **Auto-Continue Output**: Automatically clicks "Continue generating" / "สร้างต่อ" if long answers are truncated.
- 💻 **Code Extraction**: Extract and return only code blocks with `extract_code_only: true`.
- 👤 **Chrome Profiles Selector**: Auto-detects all Google Chrome profiles on your computer (Default, Profile 1, Work, Personal, emails) and lets you pick which account to chat with.
- 🧩 **Companion Chrome Extension**: Includes a Manifest V3 extension in `extension/` that can be loaded into any Chrome profile to chat in real-time with ChatGPT tabs without profile locking issues.
- 🔄 **Conversation Management**: Start new chats or continue existing threads using Conversation IDs / URLs.
- 💾 **Persistent Session**: Keeps browser profile & login cookies saved locally, so you only log in once.
- 🖥️ **Headed & Headless Modes**: Run silently in background (headless) or launch visible window (`--login` / `--headed`) for initial authentication or captcha resolution.
- 🔌 **Chrome CDP Support**: Connect to an already running Google Chrome instance via `--remote-debugging-port`.

---

## 🛠️ MCP Tools Provided

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `chatgpt_ask` | `message` (string, required)<br>`web_search` (boolean, optional)<br>`model` (string, optional)<br>`reasoning_effort` ("low"\|"medium"\|"high", optional)<br>`image_paths` (string[], optional)<br>`file_paths` (string[], optional)<br>`extract_code_only` (boolean, optional)<br>`auto_continue` (boolean, optional)<br>`profile` (string, optional)<br>`new_chat` (boolean, optional)<br>`conversation_id` (string, optional)<br>`timeout_ms` (number, optional) | Send prompt/question to ChatGPT Web with advanced controls and return assistant response. |
| `chatgpt_list_conversations` | `limit` (number, optional) | List recent conversation topics and IDs directly from the ChatGPT sidebar to search or resume chats. |
| `chatgpt_list_profiles` | None | Lists all detected Google Chrome profiles on this computer with Profile ID, Name, and Email. |
| `chatgpt_select_profile` | `profile` (string, required) | Select and switch the active Chrome profile (by ID like `Profile 1`, name, or email). |
| `chatgpt_new_chat` | None | Start a new chat session on ChatGPT Web. |
| `chatgpt_get_status` | None | Get browser status, active profile, bridge status, current URL, and active model. |
| `chatgpt_login` | `profile` (string, optional) | Open ChatGPT Web in a visible browser window to log in. |

---

## 🚀 Quick Start

### 1. Install & Build

```bash
# Clone the repository
git clone https://github.com/JonusNattapong/mcp-chatgpt.git
cd mcp-chatgpt

# Install dependencies and Chromium
npm install
npx playwright install chromium

# Build TypeScript
npm run build
```

---

## 👤 Using Chrome Profiles (2 Options)

### Option 1: Chrome Profile Auto-Detection (Direct / Headless)

You can select any Chrome profile in your system by its folder name (e.g. `Default`, `Profile 1`), display name, or email:

```bash
# List all Chrome profiles in your system
node -e "import('./dist/profile-manager.js').then(m => console.table(m.ProfileManager.listProfiles()))"

# Login with a specific profile
node dist/index.js --login --profile "Profile 1"
```

Or pass `profile` parameter directly in `chatgpt_ask` tool!

---

### Option 2: Companion Chrome Extension (Recommended for active Chrome)

If you already use Google Chrome daily with your logged-in ChatGPT account, install the companion extension:

1. Open Google Chrome with your desired Profile.
2. Navigate to `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the [`d:\Projects\Github\mcp-chatgpt\extension`](file:///d:/Projects/Github/mcp-chatgpt/extension) folder.
5. Click on the extension icon in the toolbar, set your Profile tag (e.g. "Work Account"), and click **Save & Connect**.
6. When `mcp-chatgpt` runs, it will route prompts directly through your Chrome tab!

---

## ⚙️ Configuration for MCP Clients

### 1. Antigravity / Claude Desktop

Add the following to your MCP configuration file (`claude_desktop_config.json` or Antigravity MCP settings):

```json
{
  "mcpServers": {
    "chatgpt": {
      "command": "node",
      "args": [
        "d:/Projects/Github/mcp-chatgpt/dist/index.js"
      ]
    }
  }
}
```

---

## 📖 CLI Options

```
Usage: mcp-chatgpt [options]

Options:
  --headed                 Run browser in headed (visible) mode (default: false)
  --login                  Open browser in interactive mode to log in to ChatGPT
  --profile <name_or_id>   Select specific Chrome Profile (e.g. "Default", "Profile 1", or Name/Email)
  --chrome                 Use installed Google Chrome browser (default: true)
  --no-chrome              Use Playwright bundled Chromium instead of Google Chrome
  --user-data-dir <path>   Custom browser profile directory
  --cdp <endpoint>         Connect to an existing Chrome browser via CDP endpoint
  --bridge-port <port>     Port for Chrome Extension bridge WebSocket (default: "18999")
  --bridge-only            Run only the Chrome Extension WebSocket bridge server
  --timeout <ms>           Default timeout in milliseconds (default: "120000")
  -h, --help               Display help for command
```

---

## 📄 License

MIT
