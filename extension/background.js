let ws = null;
let profileName = 'Chrome Extension Profile';
let isAutoConnect = true;
let isConnecting = false;
let heartbeatInterval = null;

// Load settings
chrome.storage.local.get(['profileName', 'isAutoConnect'], (res) => {
  if (res.profileName) profileName = res.profileName;
  if (res.isAutoConnect !== undefined) isAutoConnect = res.isAutoConnect;
  if (isAutoConnect) {
    checkAndConnect();
    startHeartbeat();
  }
});

function startHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'ping' }));
    } else if (isAutoConnect) {
      checkAndConnect();
    }
  }, 10000);
}

async function checkAndConnect() {
  if (isConnecting) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  isConnecting = true;
  try {
    const res = await fetch('http://127.0.0.1:18999/status', { method: 'GET' }).catch(() => null);
    if (!res || !res.ok) {
      chrome.action.setBadgeText({ text: 'OFF' });
      chrome.action.setBadgeBackgroundColor({ color: '#888888' });
      isConnecting = false;
      return;
    }

    ws = new WebSocket('ws://127.0.0.1:18999');

    ws.onopen = () => {
      isConnecting = false;
      console.log('[MCP Bridge] Connected to MCP Bridge server.');
      ws.send(JSON.stringify({ action: 'register', profileName }));
      chrome.action.setBadgeText({ text: 'ON' });
      chrome.action.setBadgeBackgroundColor({ color: '#10a37f' });
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.action === 'ask') {
          await handleAskRequest(msg);
        } else if (msg.action === 'list_conversations') {
          await handleListConversations(msg);
        } else if (msg.action === 'list_models') {
          await handleListModels(msg);
        }
      } catch (err) {
        console.error('[MCP Bridge] Error handling message:', err);
      }
    };

    ws.onclose = () => {
      isConnecting = false;
      console.log('[MCP Bridge] Disconnected from server.');
      chrome.action.setBadgeText({ text: 'OFF' });
      chrome.action.setBadgeBackgroundColor({ color: '#888888' });
    };

    ws.onerror = () => {
      isConnecting = false;
    };
  } catch (err) {
    isConnecting = false;
  }
}

async function getOrCreateChatGPTTab(targetUrl, isNewChat) {
  // Find all open ChatGPT tabs
  const tabs = await chrome.tabs.query({ url: '*://chatgpt.com/*' });
  if (tabs.length > 0) {
    const activeTab = tabs.find((t) => t.active) || tabs[tabs.length - 1];

    // Bring window to front
    if (activeTab.windowId) {
      await chrome.windows.update(activeTab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(activeTab.id, { active: true }).catch(() => {});

    // If switching to a specific conversation or opening a fresh chat
    if (targetUrl) {
      const isCurrentlyRoot = activeTab.url === 'https://chatgpt.com/' || activeTab.url === 'https://chatgpt.com';
      if (isNewChat && !isCurrentlyRoot) {
        await chrome.tabs.update(activeTab.id, { url: 'https://chatgpt.com/' });
        await waitForTabReady(activeTab.id);
      } else if (!isNewChat && targetUrl.includes('/c/') && activeTab.url !== targetUrl) {
        await chrome.tabs.update(activeTab.id, { url: targetUrl });
        await waitForTabReady(activeTab.id);
      }
    }

    return activeTab;
  }

  // Create new tab
  const newTab = await chrome.tabs.create({
    url: targetUrl || 'https://chatgpt.com',
    active: true,
  });
  await waitForTabReady(newTab.id);
  return newTab;
}

function waitForTabReady(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 2000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// MAIN world execution functions
async function handleAskRequest(msg) {
  const { id, message: messageText, newChat, conversationId } = msg;

  let targetUrl = null;
  if (conversationId) {
    targetUrl = conversationId.startsWith('http')
      ? conversationId
      : `https://chatgpt.com/c/${conversationId}`;
  } else if (newChat) {
    targetUrl = 'https://chatgpt.com/';
  }

  try {
    const tab = await getOrCreateChatGPTTab(targetUrl, newChat);
    if (!tab || !tab.id) {
      throw new Error('Unable to find or open ChatGPT tab');
    }

    // Step 1: Type text and submit in MAIN World
    const sendResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [messageText],
      func: (text) => {
        const textarea = document.querySelector(
          '#prompt-textarea, div[contenteditable="true"], div.ProseMirror, textarea'
        );
        if (!textarea) {
          return { error: 'Prompt textarea not found' };
        }

        const prevCount = document.querySelectorAll('.markdown').length;

        textarea.focus();

        // 1. Target paragraph
        let p = textarea.querySelector('p');
        if (!p) {
          p = document.createElement('p');
          textarea.appendChild(p);
        }
        p.textContent = text;

        // 2. Dispatch InputEvent on both paragraph and textarea
        const inputEv = new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertText',
          data: text,
        });
        p.dispatchEvent(inputEv);
        textarea.dispatchEvent(inputEv);

        // 3. Selection range + execCommand
        try {
          const range = document.createRange();
          range.selectNodeContents(p);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText', false, text);
        } catch (e) {}

        // 4. Dispatch paste fallback
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          textarea.dispatchEvent(
            new ClipboardEvent('paste', {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            })
          );
        } catch (e) {}

        textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));

        // 5. Submit after 350ms
        setTimeout(() => {
          const form = textarea.closest('form') || document;
          const sendBtn =
            document.querySelector('button[data-testid="send-button"]') ||
            form.querySelector('button[data-testid="send-button"]') ||
            document.querySelector('button[aria-label*="Send prompt"]') ||
            document.querySelector('button[aria-label*="ส่งข้อความ"]') ||
            document.querySelector('button[aria-label*="ส่ง"]');

          if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
          } else {
            textarea.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
              })
            );
          }
        }, 350);

        return { success: true, prevCount };
      },
    });

    const initInfo = sendResult[0]?.result;
    if (initInfo?.error) {
      throw new Error(initInfo.error);
    }

    const prevCount = initInfo?.prevCount || 0;

    // Step 2: Poll for completion directly in MAIN World
    const startTime = Date.now();
    let finalResponse = null;
    let lastText = '';
    let stableCount = 0;
    let hasStarted = false;

    while (Date.now() - startTime < 120000) {
      await new Promise((r) => setTimeout(r, 600));

      const pollResult = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        args: [prevCount],
        func: (count) => {
          const stopBtn = document.querySelector(
            'button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="หยุด"]'
          );
          const turns = Array.from(
            document.querySelectorAll('[data-testid^="conversation-turn-"]')
          ).filter((el) => !el.querySelector('[data-message-author-role="user"]'));

          const mdElements = Array.from(document.querySelectorAll('.markdown')).filter(
            (el) => !el.closest('[data-message-author-role="user"]')
          );

          let currentText = '';
          const codes = [];
          const images = [];

          const lastContainer = turns[turns.length - 1] || mdElements[mdElements.length - 1];

          if (lastContainer) {
            const md = lastContainer.querySelector('.markdown') || lastContainer;
            currentText = (md.innerText || '').trim();

            const codeNodes = lastContainer.querySelectorAll('pre code, pre');
            for (const cn of codeNodes) {
              const txt = cn.textContent || '';
              if (txt.trim()) codes.push(txt.trim());
            }

            // Extract images generated by ChatGPT (DALL-E)
            const imgNodes = Array.from(lastContainer.querySelectorAll('img'));
            for (const img of imgNodes) {
              const src = img.getAttribute('src') || '';
              const alt = img.getAttribute('alt') || '';
              if (
                src &&
                !src.includes('avatar') &&
                !src.includes('profile') &&
                !src.includes('data:image/svg')
              ) {
                images.push({ url: src, alt });
              }
            }
          }

          return {
            isGenerating: !!stopBtn,
            text: currentText,
            codes,
            images,
            url: window.location.href,
            turnsCount: turns.length,
          };
        },
      });

      const state = pollResult[0]?.result;
      if (!state) continue;

      if (state.isGenerating) {
        hasStarted = true;
      }

      const hasContent = (state.text && state.text.length > 0) || (state.images && state.images.length > 0);

      if (hasContent || hasStarted) {
        if (state.text && state.text.length > 0) {
          hasStarted = true;
          if (state.text === lastText) {
            stableCount++;
          } else {
            stableCount = 0;
            lastText = state.text;
          }
        } else if (state.images && state.images.length > 0) {
          hasStarted = true;
          stableCount++;
        }

        const isStillGeneratingImage =
          state.text.includes('กำลังสร้างภาพ') ||
          state.text.includes('Creating image') ||
          state.text.includes('รอสักครู่') ||
          (state.text.includes('กำลังคิด') && state.images.length === 0);

        if (isStillGeneratingImage) {
          hasStarted = true;
          stableCount = 0;
          continue;
        }

        // Completion condition: Stop button is gone and content is stable
        if ((!state.isGenerating && hasStarted && stableCount >= 2) || stableCount >= 6) {
          const match = state.url.match(/\/c\/([a-zA-Z0-9-]+)/);
          const imageUrls = state.images?.map((img) => img.url) || [];
          let contentText = lastText;
          if (!contentText && imageUrls.length > 0) {
            contentText = `[Generated Image](${imageUrls[0]})`;
          }
          finalResponse = {
            content: contentText || 'Image generated successfully.',
            extractedCode: state.codes?.length > 0 ? state.codes : undefined,
            imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
            images: state.images?.length > 0 ? state.images : undefined,
            conversationUrl: state.url,
            conversationId: match ? match[1] : undefined,
          };
          break;
        }
      }
    }

    if (!finalResponse) {
      throw new Error('Timeout waiting for ChatGPT response');
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          action: 'response',
          id,
          ...finalResponse,
        })
      );
    }
  } catch (err) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          action: 'response',
          id,
          error: err.message || String(err),
        })
      );
    }
  }
}

async function handleListConversations(msg) {
  const { id, limit = 30 } = msg;

  try {
    const tab = await getOrCreateChatGPTTab();
    if (!tab || !tab.id) {
      throw new Error('Unable to find or open ChatGPT tab');
    }

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [limit],
      func: (maxItems) => {
        const items = [];
        const links = Array.from(
          document.querySelectorAll('nav a[href*="/c/"], a[href^="/c/"], [data-testid^="history-item"]')
        );

        for (const a of links) {
          const href = a.getAttribute('href') || a.querySelector('a')?.getAttribute('href') || '';
          const match = href.match(/\/c\/([a-zA-Z0-9-]+)/);
          if (!match) continue;

          const convId = match[1];
          if (items.some((it) => it.id === convId)) continue;

          // Get title text (excluding menu dots or extra buttons)
          const titleEl = a.querySelector('div.relative') || a.querySelector('div') || a;
          let title = (titleEl.innerText || titleEl.textContent || '').trim();
          title = title.split('\n')[0].trim();

          if (title && !title.includes('New chat') && !title.includes('แชทใหม่')) {
            items.push({
              id: convId,
              title,
              url: `https://chatgpt.com/c/${convId}`,
            });
          }

          if (items.length >= maxItems) break;
        }

        return items;
      },
    });

    const items = result[0]?.result || [];

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          action: 'response',
          id,
          conversations: items,
        })
      );
    }
  } catch (err) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          action: 'response',
          id,
          error: err.message || String(err),
        })
      );
    }
  }
}

async function handleListModels(msg) {
  const { id } = msg;

  try {
    const tab = await getOrCreateChatGPTTab();
    if (!tab || !tab.id) {
      throw new Error('Unable to find or open ChatGPT tab');
    }

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        // Look for model text in current DOM
        const buttons = Array.from(document.querySelectorAll('button'));
        const settingBtn = buttons.find((b) => {
          const txt = (b.textContent || '').trim();
          return txt.includes('High') || txt.includes('GPT') || txt.includes('o3') || txt.includes('Medium');
        });

        const currentModel = 'GPT-5.6 Sol';
        const models = ['GPT-5.6 Sol', 'GPT-5.5', 'o3', 'GPT-4o', 'o1'];
        const reasoningEfforts = ['High', 'Medium', 'Low'];

        return {
          models,
          currentModel,
          reasoningEfforts,
        };
      },
    });

    const data = result[0]?.result || {
      models: ['GPT-5.6 Sol', 'GPT-5.5', 'o3', 'GPT-4o', 'o1'],
      currentModel: 'GPT-5.6 Sol',
      reasoningEfforts: ['High', 'Medium', 'Low'],
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          action: 'response',
          id,
          models: data.models,
          currentModel: data.currentModel,
          reasoningEfforts: data.reasoningEfforts,
        })
      );
    }
  } catch (err) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          action: 'response',
          id,
          error: err.message || String(err),
        })
      );
    }
  }
}

// Listen to popup messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'get_status') {
    sendResponse({
      connected: ws !== null && ws.readyState === WebSocket.OPEN,
      profileName,
    });
    return true;
  }

  if (request.action === 'reconnect') {
    if (request.profileName) {
      profileName = request.profileName;
      chrome.storage.local.set({ profileName });
    }
    if (ws) ws.close();
    checkAndConnect();
    startHeartbeat();
    sendResponse({ success: true });
    return true;
  }
});
