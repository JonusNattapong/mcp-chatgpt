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
- 🧰 **Workspace Tools**: Search files, run builds/tests, and edit code with cross-platform `shell_command` and root-confined `apply_patch` tools.
- 🌐 **Remote MCP Tunnel**: Optional Streamable HTTP endpoint with Bearer authentication for Cloudflare Tunnel/ngrok or another HTTPS tunnel.

---

## 🛠️ MCP Tools Provided

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| `shell_command` | `command` (string, required)<br>`workdir` (string, optional)<br>`shell` (`auto`\|`powershell`\|`bash`, optional)<br>`timeout_ms` (number, optional) | Run commands with a working directory under the configured root. Auto-selects PowerShell on Windows and Bash on Linux/macOS. |
| `apply_patch` | `patch` (string, required) | Add, update, delete, or move files under the configured shell root using structured patches. |
| `chatgpt_ask` | `message` (string, required)<br>`web_search` (boolean, optional)<br>`model` (string, optional)<br>`reasoning_effort` ("low"\|"medium"\|"high", optional)<br>`image_paths` (string[], optional)<br>`file_paths` (string[], optional)<br>`extract_code_only` (boolean, optional)<br>`auto_continue` (boolean, optional)<br>`refresh_page` (boolean, optional)<br>`profile` (string, optional)<br>`new_chat` (boolean, optional)<br>`conversation_id` (string, optional)<br>`timeout_ms` (number, optional) | Send prompt/question to ChatGPT Web with advanced controls and return assistant response. |
| `chatgpt_reload` | None | Reload and refresh the current ChatGPT Web page to recover from stuck states or connection glitches. |
| `chatgpt_list_models` | None | List all available AI models (GPT-5.6 Sol, GPT-5.5, o3, GPT-4o, o1) and reasoning effort options for this account. |
| `chatgpt_list_conversations` | `limit` (number, optional) | List recent conversation topics and IDs directly from the ChatGPT sidebar to search or resume chats. |
| `chatgpt_list_profiles` | None | Lists all detected Google Chrome profiles on this computer with Profile ID, Name, and Email. |
| `chatgpt_select_profile` | `profile` (string, required) | Select and switch the active Chrome profile (by ID like `Profile 1`, name, or email). |
| `chatgpt_new_chat` | None | Start a new chat session on ChatGPT Web. |
| `chatgpt_get_status` | None | Get browser status, active profile, bridge status, current URL, and active model. |
| `chatgpt_login` | `profile` (string, optional) | Open ChatGPT Web in a visible browser window to log in. |

---

## 🚀 Quick Start

> [!WARNING]
> `shell_command` can execute arbitrary commands with the same operating-system permissions as the MCP server. `--shell-root` limits its selectable starting working directory, but it is not an OS sandbox. Run the server as a restricted user or in a container when connecting untrusted clients. `apply_patch` does enforce that all changed paths stay under `--shell-root`.

### Remote MCP tunnel

Local `stdio` remains the default. To expose a remote-compatible MCP endpoint, start HTTP mode with a token:

```bash
mcp-chatgpt --http --http-token "change-this-token"
```

The endpoint is `http://127.0.0.1:8787/mcp`. Put a tunnel in front of it, for example:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Configure the remote MCP client with the public tunnel URL ending in `/mcp` and the header `Authorization: Bearer change-this-token`. `/healthz` can be used for a tunnel health check. If either this process or the tunnel stops, remote MCP requests are unavailable.

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

# Install the MCP command globally
npm install -g .
```

After installation, verify it with:

```bash
mcp-chatgpt --help
```

The package runs `npm run build` automatically during installation, so the global command always uses the current TypeScript source when installed from a local checkout.

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

You can connect `mcp-chatgpt` to any AI client supporting the Model Context Protocol (MCP):

### 1. Antigravity IDE / Gemini CLI
File location: `~/.gemini/config/mcp_config.json` (Windows: `C:\Users\<User>\.gemini\config\mcp_config.json`)

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

### 2. Claude Desktop
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

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

### 3. Cursor IDE
Add to your project's `.cursor/mcp.json` or in **Cursor Settings > Features > MCP**:

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

### 4. VS Code (Cline / Roo Code / Roo Clinic)
File location: 
- Cline: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- Roo Code: `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\cline_mcp_settings.json`

```json
{
  "mcpServers": {
    "chatgpt": {
      "command": "node",
      "args": [
        "d:/Projects/Github/mcp-chatgpt/dist/index.js"
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

---

### 5. Windsurf Editor (Codeium)
File location: `~/.codeium/windsurf/mcp_config.json`

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

### 6. Zed Editor
Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "chatgpt": {
      "command": {
        "path": "node",
        "args": ["d:/Projects/Github/mcp-chatgpt/dist/index.js"]
      }
    }
  }
}
```

---

### 7. LibreChat (`librechat.yaml`)
Add to `librechat.yaml`:

```yaml
mcpServers:
  chatgpt:
    type: stdio
    command: node
    args:
      - d:/Projects/Github/mcp-chatgpt/dist/index.js
```

---

### 8. Remote Connection via Cloudflare Tunnel (Remote URL / SSE / mcp-remote)

If your ChatGPT browser or bridge server runs on a home computer or VPS, and you want AI clients on other machines/laptops to connect to it securely across the internet via Cloudflare Tunnel:

#### Step A: Expose Bridge Server on the Host Machine
```bash
# Start Cloudflare Quick Tunnel (Free, no account required)
cloudflared tunnel --url http://127.0.0.1:18999
```
> This will generate a public HTTPS URL, for example: `https://alpha-bravo-charlie.trycloudflare.com`

---

#### Step B: Configure Client on Remote Machines

##### 1. Antigravity / Gemini CLI (Remote SSE / URL)
Add to `~/.gemini/config/mcp_config.json`:
```json
{
  "mcpServers": {
    "chatgpt-remote": {
      "serverUrl": "https://alpha-bravo-charlie.trycloudflare.com/sse"
    }
  }
}
```

##### 2. Cursor IDE (Remote SSE)
Add to `.cursor/mcp.json` or Cursor Settings:
```json
{
  "mcpServers": {
    "chatgpt-remote": {
      "url": "https://alpha-bravo-charlie.trycloudflare.com/sse"
    }
  }
}
```

##### 3. VS Code Cline / Roo Code (Remote SSE)
Add to `cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "chatgpt-remote": {
      "url": "https://alpha-bravo-charlie.trycloudflare.com/sse",
      "type": "sse",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

##### 4. Claude Desktop / Any stdio Client (via `mcp-remote`)
For clients that only accept `command` (stdio), use `mcp-remote` to bridge the Cloudflare Tunnel URL:
```json
{
  "mcpServers": {
    "chatgpt-remote": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://alpha-bravo-charlie.trycloudflare.com/sse"
      ]
    }
  }
}
```

##### 5. LibreChat (`librechat.yaml`)
```yaml
mcpServers:
  chatgpt-remote:
    type: sse
    url: https://alpha-bravo-charlie.trycloudflare.com/sse
```

##### 6. Direct HTTP REST API (cURL / Python / Node.js)
You can also interact directly with the bridge endpoints via Cloudflare:
```bash
# Query status
curl -s https://alpha-bravo-charlie.trycloudflare.com/status

# Ask a question
curl -X POST https://alpha-bravo-charlie.trycloudflare.com/ask \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from Cloudflare Tunnel!"}'
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
  --shell-root <path>      Restrict shell and patch tools to this directory (default: current directory)
  --shell-max-timeout <ms> Maximum shell command timeout in milliseconds (default: "300000")
  --http                   Expose an MCP Streamable HTTP endpoint for a tunnel/remote client
  --http-host <host>       HTTP bind host (default: "127.0.0.1")
  --http-port <port>       HTTP port for the MCP endpoint (default: "8787")
  --http-token <token>     Bearer token required by remote MCP clients (or MCP_HTTP_TOKEN)
  --timeout <ms>           Default timeout in milliseconds (default: "120000")
  -h, --help               Display help for command
```

---

## 🌟 Live Interactive Memory & Context Retention Showcase

The following is an actual, unedited multi-turn interactive session executed live via `mcp-chatgpt`:

### Turn 1: Setting Context in a Fresh Session (`new_chat: true`)
**Request:**
```json
{
  "message": "สวัสดีครับ ผมชื่อ โจ๊กเกอร์ เป็น Software Architect ชอบเขียน Go และ TypeScript กำลังพัฒนาโปรเจกต์ชื่อ MCP-ChatGPT ฝากจำข้อมูลนี้ไว้หน่อยนะครับ ตอบสั้นๆ 1 ประโยคยืนยัน",
  "new_chat": true
}
```
**ChatGPT Response:**
> *"จำไว้แล้วครับ: คุณชื่อโจ๊กเกอร์ เป็น Software Architect ชอบ Go และ TypeScript และกำลังพัฒนาโปรเจกต์ MCP-ChatGPT ครับ"*
> 
> *URL: [`https://chatgpt.com/c/6a86843c-8f30-83ec-b064-d27f7f832244`](https://chatgpt.com/c/6a86843c-8f30-83ec-b064-d27f7f832244)*

---

### Turn 2: Follow-up Memory Recall (`conversation_id`)
**Request:**
```json
{
  "message": "ไหนลองทบทวนดูซิว่า ผมชื่ออะไร ชอบเขียนภาษาอะไร และกำลังทำโปรเจกต์ชื่ออะไรอยู่?",
  "conversation_id": "6a86843c-8f30-83ec-b064-d27f7f832244"
}
```
**ChatGPT Response (Recalled in 6s):**
> *"คุณชื่อ โจ๊กเกอร์ ชอบเขียน Go และ TypeScript และกำลังพัฒนาโปรเจกต์ชื่อ MCP-ChatGPT อยู่ครับ 🫡"*

---

## 🤖 AI Assistant System Prompt & Integration Instruction

Copy and paste the following instruction directly into your AI Assistant (Cursor Rules, Claude System Prompt, Antigravity Custom Instructions, Cline, Roo Code) so your AI automatically knows **when** and **how** to call `mcp-chatgpt`:

````markdown
# 🛠️ Instruction: Setup and Integrate `mcp-chatgpt` MCP Server

You are integrated with the `mcp-chatgpt` MCP server, granting you direct access to ChatGPT Web capabilities (o3-mini, o1, GPT-4o, live Web Search, DALL-E, and multimodal file analysis).

### 🎯 When to Automatically Use `chatgpt_ask`:

1. **Deep Reasoning & Hard Coding Tasks**:
   - For complex architecture designs, difficult debugging, or advanced algorithms, call `chatgpt_ask` with:
     `{ "model": "o3-mini", "reasoning_effort": "high", "extract_code_only": true }`
2. **Live Web Information & Current News**:
   - When the user asks for up-to-date news, today's market data, or the latest documentation of newly updated packages, call:
     `{ "web_search": true }`
3. **Image Generation (DALL-E 3)**:
   - When the user requests an image, logo, or icon design, request it via `chatgpt_ask` and present the returned `imageUrls` directly to the user.
4. **Heavy Document & File Analysis**:
   - When analyzing CSV, Excel spreadsheets, PDFs, or large source code files, attach them via `file_paths` or `image_paths`.
5. **Continuous Conversations**:
   - Always track and pass `conversation_id` to continue in the same thread, or pass `new_chat: true` when starting an unrelated topic.
6. **Finding Past Chats**:
   - Call `chatgpt_list_conversations` to search for existing topic IDs before resuming a specific past conversation.
````

---

## 📄 License

MIT
