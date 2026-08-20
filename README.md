# 🚀 mcp-chatgpt

เซิร์ฟเวอร์ **Model Context Protocol (MCP)** ประสิทธิภาพสูง สำหรับเชื่อมต่อ AI Client (เช่น Claude Desktop, Cursor, Cline, Antigravity) เข้ากับ **ChatGPT Web** เป็นเครื่องยนต์หลัก พร้อมรองรับ **Google Gemini, Z.ai (GLM-5.2) และ Kimi AI (K3)** ผ่าน **Chrome Extension Bridge** หรือ **Playwright Automation** โดยตรงจากโปรไฟล์เบราว์เซอร์ในเครื่องของคุณ

---

## 🌟 ฟีเจอร์เด่น (Key Features)

* 🟢 **ChatGPT Web First (หลัก):** สนทนาต่อเนื่อง, ค้นหาเว็บ (`web_search`), วิเคราะห์ไฟล์/รูปภาพ, เลือกโมเดล (GPT-4o, o3-mini) และเลือกระดับการคิด (`reasoning_effort`: High / Medium / Low)
* 🔌 **Chrome Extension Bridge:** เชื่อมต่อตรงกับแท็บเบราว์เซอร์ที่เปิดอยู่แบบ Real-time ไม่ต้องล็อกอินซ้ำ และไม่รบกวนการทำงานปกติ
* 🌐 **Multi-Provider Support (เสริม):** สลับไปใช้งาน **Google Gemini**, **Z.ai (GLM-5.2 Deep Think)** หรือ **Kimi AI (K3)** ได้ในระบบเดียว
* 📁 **Workspace & Shell Tools:** มีเครื่องมือสั่งรันคำสั่ง Shell (`shell_command`) และแก้ไขไฟล์ (`apply_patch`) อย่างปลอดภัยภายในโปรเจกต์
* 👤 **Chrome Profile Selector:** ตรวจจับและสลับโปรไฟล์ Chrome ที่มีอยู่ในเครื่องอัตโนมัติ
* 🔒 **Local & Remote MCP:** รองรับทั้งโหมด Local stdio สำหรับใช้งานในเครื่อง และโหมด Remote Streamable HTTP (พร้อม Bearer Token Auth และ Cloudflare Tunnel)

---

## 🛠️ รายการ MCP Tools (Tools Reference)

### 1. เครื่องมือหลัก ChatGPT & Unified

| Tool Name | คำอธิบาย | พารามิเตอร์หลัก |
| :--- | :--- | :--- |
| `chatgpt_ask` | ส่งคำถามไปยัง ChatGPT Web | `message`, `model`, `reasoning_effort`, `web_search`, `file_paths`, `image_paths`, `conversation_id`, `new_chat` |
| `chatgpt_new_chat` | เริ่มต้นบทสนทนาใหม่บน ChatGPT | - |
| `chatgpt_list_conversations` | ดึงประวัติรายการบทสนทนาล่าสุด | `limit` (ค่าเริ่มต้น: 20) |
| `chatgpt_list_models` | ดึงรายชื่อโมเดลที่บัญชีสามารถใช้งานได้ | - |
| `chatgpt_get_status` | ตรวจสอบสถานะการเชื่อมต่อและการล็อกอิน | - |
| `llm_ask` | สั่งคำถามไปยัง Provider ใดก็ได้ | `message`, `provider` (`chatgpt` \| `gemini` \| `kimi` \| `zai`), `model` |

### 2. เครื่องมือ Multi-Provider (เสริม)

| Provider | Tools | ความสามารถเด่น |
| :--- | :--- | :--- |
| **Google Gemini** | `gemini_ask`, `gemini_new_chat`, `gemini_get_status` | เชื่อมต่อ `gemini.google.com/app` ค้นหาแท็บอัตโนมัติ |
| **Z.ai** | `zai_ask`, `zai_new_chat`, `zai_get_status` | เชื่อมต่อ `chat.z.ai` รองรับโมเดล GLM-5.2 Deep Think |
| **Kimi AI** | `kimi_ask`, `kimi_new_chat`, `kimi_get_status` | เชื่อมต่อ `kimi.ai` รองรับดีไซน์ใหม่ K3 ProseMirror |

### 3. เครื่องมือ Workspace & Profiles

| Tool Name | คำอธิบาย | พารามิเตอร์หลัก |
| :--- | :--- | :--- |
| `shell_command` | รันคำสั่ง Shell ในไดเรกทอรีโปรเจกต์อย่างปลอดภัย | `command`, `workdir`, `timeout_ms`, `shell` |
| `apply_patch` | แก้ไข/เขียนทับเนื้อหาไฟล์ในโปรเจกต์ | `patch` (V4 format) |
| `chatgpt_list_profiles` | แสดงรายการโปรไฟล์ Chrome ที่พบบนเครื่อง | - |
| `chatgpt_select_profile` | เลือกโปรไฟล์ Chrome สำหรับใช้งาน | `profile` |

---

## 📦 การติดตั้งและการเตรียมความพร้อม (Installation)

### 1. ติดตั้ง Dependencies และ Build โปรเจกต์
```bash
git clone https://github.com/JonusNattapong/mcp-chatgpt.git
cd mcp-chatgpt
npm install
npm run build
```

### 2. ติดตั้ง Chrome Extension Bridge (แนะนำ)
1. เปิด Google Chrome แล้วไปที่ `chrome://extensions/`
2. เปิดสวิตช์ **Developer mode** ที่มุมขวาบน
3. คลิก **Load unpacked** แล้วเลือกโฟลเดอร์ `extension` ภายในโปรเจกต์นี้
4. คลิกไอคอนส่วนขยาย **MCP Web LLMs Bridge** เพื่อเปิดใช้งาน

---

## ⚙️ การตั้งค่าใน AI Client (Configuration)

### 1. Claude Desktop / Cursor / Antigravity IDE (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "chatgpt-bridge": {
      "command": "node",
      "args": ["D:/Projects/Github/mcp-chatgpt/dist/index.js"]
    }
  }
}
```

### 2. เปิดใช้งานแบบ Remote HTTP Server (พร้อม Bearer Auth)
```bash
# รัน HTTP Server พอร์ต 8686
node dist/index.js --http 8686 --auth-token "your-secret-token"

# หรือเชื่อมต่อผ่าน Cloudflare Tunnel
node dist/index.js --http 8686 --tunnel
```

---

## 🧪 การทดสอบระบบ (Testing)

```bash
# รัน Unit Tests ทั้งหมด
npm test

# รัน Bridge Mode อย่างเดียว
npm run bridge
```

---

## 📄 License
MIT License © 2026 JonusNattapong
