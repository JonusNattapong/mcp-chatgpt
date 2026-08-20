// Content script running on ChatGPT, Gemini, Kimi, and Z.ai

if (!window.__MCP_BRIDGE_INITIALIZED__) {
  window.__MCP_BRIDGE_INITIALIZED__ = true;

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ask_in_page') {
      console.log('[MCP Bridge] Received prompt to send:', request.message);
      sendResponse({ received: true });

      handleAskInPage(request)
        .then((res) => {
          console.log('[MCP Bridge] Response completed:', res);
          chrome.runtime.sendMessage({
            action: 'response_done',
            id: request.id,
            ...res,
          });
        })
        .catch((err) => {
          console.error('[MCP Bridge] Error in page:', err);
          chrome.runtime.sendMessage({
            action: 'response_done',
            id: request.id,
            error: err.message || String(err),
          });
        });
    }
  });
}

function detectPlatform() {
  const host = window.location.hostname;
  if (host.includes('gemini.google.com')) return 'gemini';
  if (host.includes('kimi.ai')) return 'kimi';
  if (host.includes('z.ai')) return 'zai';
  return 'chatgpt';
}

async function handleAskInPage(options) {
  const platform = detectPlatform();
  const messageText = options.message;

  // 1. Locate prompt input element according to platform
  let inputSelector = '#prompt-textarea, div[contenteditable="true"], textarea, div.ProseMirror';
  if (platform === 'gemini') {
    inputSelector = 'rich-textarea div[contenteditable="true"], div.ql-editor, textarea, div[contenteditable="true"]';
  } else if (platform === 'kimi') {
    inputSelector = '.chat-input-editor, div[contenteditable="true"], textarea, div[class*="editor"]';
  } else if (platform === 'zai') {
    inputSelector = 'textarea, div[contenteditable="true"]';
  }

  const inputEl = await waitForElement(inputSelector, 15000);
  if (!inputEl) {
    throw new Error(`[${platform.toUpperCase()}] Prompt input not found. Please ensure you are logged in.`);
  }

  // 2. Count existing responses
  let responseSelector = '.markdown, [data-message-author-role="assistant"]';
  if (platform === 'gemini') {
    responseSelector = 'model-response, message-content, .response-container-content';
  } else if (platform === 'kimi') {
    responseSelector = 'div[class*="segment-assistant"], div[class*="chat-item-assistant"], div[data-role="assistant"], div[class*="message-assistant"], .markdown';
  } else if (platform === 'zai') {
    responseSelector = 'div[class*="assistant"], div[class*="markdown"], div[class*="message-body"]';
  }

  const prevCount = document.querySelectorAll(responseSelector).length;

  // 3. Focus and insert text
  await insertTextIntoElement(inputEl, messageText, platform);
  await new Promise((r) => setTimeout(r, 400));

  // 4. Click Send Button or press Enter
  await submitPrompt(inputEl, platform);

  // 5. Wait for assistant response to complete
  const responseData = await waitForCompletion(responseSelector, prevCount, options.timeoutMs || 120000, platform);

  const url = window.location.href;
  return {
    provider: platform,
    content: responseData.text,
    extractedCode: responseData.codes?.length > 0 ? responseData.codes : undefined,
    conversationUrl: url,
  };
}

async function insertTextIntoElement(el, text, platform) {
  el.focus();
  await new Promise((r) => setTimeout(r, 100));

  if (el.tagName.toLowerCase() === 'textarea' || el.tagName.toLowerCase() === 'input') {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  // Target paragraph in contenteditable
  let p = el.querySelector('p');
  if (!p && platform === 'chatgpt') {
    p = document.createElement('p');
    el.appendChild(p);
  }

  if (p) {
    p.textContent = text;
  } else {
    el.innerText = text;
  }

  const inputEv = new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType: 'insertText',
    data: text,
  });
  if (p) p.dispatchEvent(inputEv);
  el.dispatchEvent(inputEv);

  try {
    const range = document.createRange();
    range.selectNodeContents(p || el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, text);
  } catch (e) {}

  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function submitPrompt(el, platform) {
  await new Promise((r) => setTimeout(r, 400));

  let sendBtn = null;
  if (platform === 'gemini') {
    sendBtn = document.querySelector(
      'button[aria-label*="Send prompt"], button[aria-label*="Send"], button[aria-label*="ส่ง"], button.send-button, button[mattooltip*="Send"]'
    );
  } else if (platform === 'kimi') {
    sendBtn = document.querySelector('.send-button-container:not(.disabled), div[class*="send-button"]:not(.disabled), button[class*="send"], svg.send-icon');
  } else if (platform === 'zai') {
    sendBtn = document.querySelector('button[type="submit"], button[class*="send"], button[aria-label*="Send"]');
  } else {
    const form = el.closest('form') || document;
    sendBtn =
      document.querySelector('button[data-testid="send-button"]') ||
      form.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send prompt"]') ||
      document.querySelector('button[aria-label*="ส่ง"]');
  }

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
    console.log('[MCP Bridge] Clicked send button');
    return;
  }

  // Fallback: Dispatch Enter key
  const enterDown = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(enterDown);
  console.log('[MCP Bridge] Dispatched Enter key event');
}

function waitForElement(selector, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const startTime = Date.now();
    const interval = setInterval(() => {
      const found = document.querySelector(selector);
      if (found) {
        clearInterval(interval);
        resolve(found);
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(interval);
        resolve(null);
      }
    }, 300);
  });
}

function waitForCompletion(responseSelector, previousCount, timeoutMs = 120000, platform = 'chatgpt') {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let lastText = '';
    let stableCount = 0;
    let hasStarted = false;

    const interval = setInterval(() => {
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(interval);
        if (lastText) {
          return resolve({ text: lastText, codes: extractCodeBlocks() });
        }
        return reject(new Error(`Timeout waiting for ${platform} response`));
      }

      // Check stop button
      const stopBtn = document.querySelector(
        'button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="หยุด"], button[class*="stop"], mat-progress-spinner'
      );

      if (stopBtn) {
        hasStarted = true;
      }

      const elements = document.querySelectorAll(responseSelector);

      if (elements.length > previousCount || (hasStarted && elements.length > 0)) {
        hasStarted = true;
        const lastEl = elements[elements.length - 1];
        const text = (lastEl.innerText || '').trim();

        if (text.length > 0) {
          if (text === lastText) {
            stableCount++;
          } else {
            stableCount = 0;
            lastText = text;
          }

          if ((!stopBtn && hasStarted && stableCount >= 2) || stableCount >= 4) {
            clearInterval(interval);
            return resolve({ text: lastText, codes: extractCodeBlocks(lastEl) });
          }
        }
      } else if (hasStarted && !stopBtn && lastText.length > 0) {
        clearInterval(interval);
        return resolve({ text: lastText, codes: extractCodeBlocks() });
      }
    }, 500);
  });
}

function extractCodeBlocks(container = document) {
  const codes = [];
  const codeElements = container.querySelectorAll('pre code, pre');
  for (const el of codeElements) {
    const text = el.textContent || '';
    if (text.trim()) {
      codes.push(text.trim());
    }
  }
  return codes;
}
