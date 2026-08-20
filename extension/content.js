// Content script running on https://chatgpt.com/*

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

async function handleAskInPage(options) {
  const messageText = options.message;

  if (options.newChat && window.location.pathname !== '/') {
    window.location.href = 'https://chatgpt.com';
    await new Promise((r) => setTimeout(r, 2000));
  }

  // 1. Locate prompt input element
  const textarea = await waitForElement(
    '#prompt-textarea, div[contenteditable="true"], div.ProseMirror, textarea',
    15000
  );

  if (!textarea) {
    throw new Error('ChatGPT prompt input not found. Please ensure ChatGPT is open and you are logged in.');
  }

  // 2. Count existing assistant responses before sending
  const prevCount = document.querySelectorAll('.markdown').length;

  // 3. Focus and insert text
  await insertTextIntoChatGPT(textarea, messageText);
  await new Promise((r) => setTimeout(r, 400));

  // 4. Click Send Button or press Enter
  await submitPrompt(textarea);

  // 5. Wait for assistant response to complete
  const responseData = await waitForCompletion(prevCount, 120000);

  const url = window.location.href;
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
  const conversationId = match ? match[1] : undefined;

  return {
    content: responseData.text,
    extractedCode: responseData.codes?.length > 0 ? responseData.codes : undefined,
    conversationUrl: url,
    conversationId,
  };
}

async function insertTextIntoChatGPT(el, text) {
  el.focus();
  await new Promise((r) => setTimeout(r, 100));

  // Method 1: Target paragraph in ProseMirror / Lexical
  let p = el.querySelector('p');
  if (!p) {
    p = document.createElement('p');
    el.appendChild(p);
  }
  p.textContent = text;

  // Method 2: Dispatch InputEvent on both paragraph and editor
  const inputEv = new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType: 'insertText',
    data: text,
  });
  p.dispatchEvent(inputEv);
  el.dispatchEvent(inputEv);

  // Method 3: Selection range + execCommand
  try {
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, text);
  } catch (e) {}

  // Method 4: Paste event
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const pasteEv = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(pasteEv);
  } catch (e) {}

  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function submitPrompt(el) {
  await new Promise((r) => setTimeout(r, 400));

  // Find send button
  const form = el.closest('form') || document;
  const sendBtn =
    document.querySelector('button[data-testid="send-button"]') ||
    form.querySelector('button[data-testid="send-button"]') ||
    document.querySelector('button[aria-label*="Send prompt"]') ||
    document.querySelector('button[aria-label*="ส่งข้อความ"]') ||
    document.querySelector('button[aria-label*="ส่ง"]');

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

function waitForCompletion(previousCount, timeoutMs = 120000) {
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
        return reject(new Error('Timeout waiting for ChatGPT response'));
      }

      // Check stop button
      const stopBtn = document.querySelector(
        'button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="หยุด"]'
      );

      if (stopBtn) {
        hasStarted = true;
      }

      const mdElements = document.querySelectorAll('.markdown');

      if (mdElements.length > previousCount || (hasStarted && mdElements.length > 0)) {
        hasStarted = true;
        const lastEl = mdElements[mdElements.length - 1];
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
