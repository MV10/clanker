/**
 * Clanker Background Service Worker
 * Handles LLM API communication and extension lifecycle
 */

// Load storage module for IndexedDB access
importScripts('storage.js');
const Storage = self.ClankerStorage;

const STORAGE_KEYS = {
  API_ENDPOINT: 'apiEndpoint',
  API_KEY: 'apiKey',
  MODEL: 'model',
  USER_NAME: 'userName',
  HISTORY_SIZE: 'historySize'
};

/**
 * Operating modes
 */
const MODES = {
  UNINITIALIZED: 'uninitialized',
  DEACTIVATED: 'deactivated',
  ACTIVE: 'active',
  AVAILABLE: 'available'
};

/**
 * Toolbar icon paths
 */
const ICONS = {
  DEFAULT: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png'
  },
  DISABLED: {
    16: 'icons/disabled16.png',
    48: 'icons/disabled48.png',
    128: 'icons/disabled128.png'
  }
};

/**
 * Context menu item IDs
 */
const MENU_IDS = {
  PARENT: 'clanker-menu',
  MODE_DEACTIVATED: 'clanker-mode-deactivated',
  MODE_ACTIVE: 'clanker-mode-active',
  MODE_AVAILABLE: 'clanker-mode-available',
  SEPARATOR: 'clanker-separator',
  SETTINGS: 'clanker-settings',
  SEPARATOR2: 'clanker-separator2',
  DIAGNOSTICS: 'clanker-diagnostics',
  DIAG_LOG: 'clanker-diag-log',
  DIAG_DEACTIVATE_ALL: 'clanker-diag-deactivate-all',
  DIAG_RESET_CONVERSATION: 'clanker-diag-reset-conversation',
  DIAG_RESET_ALL: 'clanker-diag-reset-all'
};

/**
 * Track current mode per tab
 */
const tabModes = new Map();

/**
 * Track which tabs have debugger attached
 */
const debuggerAttached = new Set();

/**
 * Message handler for communication with popup and content scripts
 */
// addListener is still valid for extensions, it is deprecated for DOM scripts
// noinspection JSDeprecatedSymbols
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'TEST_CONNECTION':
      handleTestConnection(message.payload).then(sendResponse);
      return true; // Keep channel open for async response

    case 'SEND_TO_LLM':
      handleLLMRequest(message.payload).then(sendResponse);
      return true;

    case 'GET_CONFIG':
      handleGetConfig().then(sendResponse);
      return true;

    case 'GET_MODE':
      handleGetMode(sender.tab?.id).then(sendResponse);
      return true;

    case 'SET_MODE':
      handleSetMode(sender.tab?.id, message.mode).then(sendResponse);
      return true;

    case 'CONTENT_READY':
      // Content script is ready, update context menu for this tab
      if (sender.tab?.id) {
        updateContextMenuForTab(sender.tab.id);
      }
      sendResponse({ success: true });
      return false;

    case 'CLICK_ELEMENT':
      // Click an element by ID using main world injection
      handleClickElement(sender.tab?.id, message.elementId).then(sendResponse);
      return true;

    case 'SEND_CHAT_MESSAGE':
      // Send a chat message using main world injection
      handleSendMessage(sender.tab?.id, message.text).then(sendResponse);
      return true;

    case 'DETACH_DEBUGGER':
      // Content script requests debugger detach (after deactivation message sent)
      detachDebugger(sender.tab?.id).then(() => sendResponse({ success: true }));
      return true;

    default:
      console.warn('Unknown message type:', message.type);
      sendResponse({ success: false, error: 'Unknown message type' });
  }
});

/**
 * Test API connection with a minimal request
 */
async function handleTestConnection({ endpoint, apiKey, model }) {
  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 5
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error?.message || `HTTP ${response.status}`
      };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Validate endpoint URL
 */
function isValidEndpoint(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Send conversation to LLM and get response
 */
async function handleLLMRequest({ messages, systemPrompt, summary, customization, imageData }) {
  console.log('[Clanker] handleLLMRequest called:', {
    messageCount: messages?.length,
    hasSystemPrompt: !!systemPrompt,
    hasSummary: !!summary,
    hasCustomization: !!customization,
    hasImageData: !!imageData
  });

  try {
    const config = await Storage.get(Object.values(STORAGE_KEYS));

    if (!config[STORAGE_KEYS.API_ENDPOINT] ||
        !config[STORAGE_KEYS.API_KEY] ||
        !config[STORAGE_KEYS.MODEL]) {
      console.log('[Clanker] Extension not configured');
      return { success: false, error: 'Extension not configured' };
    }

    // Validate endpoint
    if (!isValidEndpoint(config[STORAGE_KEYS.API_ENDPOINT])) {
      return { success: false, error: 'Invalid API endpoint URL' };
    }

    const apiMessages = [];

    // Add system prompt if provided
    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt });
    }

    // Add active customization as additional system instruction
    if (customization) {
      apiMessages.push({
        role: 'system',
        content: `[ACTIVE CUSTOMIZATION]\n${customization}`
      });
    }

    // Add conversation summary if available (provides context for older messages)
    if (summary) {
      apiMessages.push({
        role: 'user',
        content: `[CONVERSATION SUMMARY - older messages not shown]\n${summary}`
      });
    }

    // Add actual image data if this is a follow-up request with image
    if (imageData) {
      // For vision-capable models, include as image content
      apiMessages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `[IMAGE DATA for ${imageData.src} - ${imageData.width}x${imageData.height}]`
          },
          {
            type: 'image_url',
            image_url: {
              url: imageData.dataUrl,
              detail: 'high'
            }
          }
        ]
      });
    }

    // Add recent literal messages (images are inline as [IMAGE: blob:...] format)
    apiMessages.push(...messages);

    console.log('[Clanker] Sending API request to:', config[STORAGE_KEYS.API_ENDPOINT]);
    console.log('[Clanker] Using model:', config[STORAGE_KEYS.MODEL]);
    console.log('[Clanker] Total messages in request:', apiMessages.length);

    const response = await fetch(
      `${config[STORAGE_KEYS.API_ENDPOINT]}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config[STORAGE_KEYS.API_KEY]}`
        },
        body: JSON.stringify({
          model: config[STORAGE_KEYS.MODEL],
          messages: apiMessages,
          max_tokens: 512,
          temperature: 0.7
        })
      }
    );

    console.log('[Clanker] API response status:', response.status);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[Clanker] API error:', errorData);
      return {
        success: false,
        error: errorData.error?.message || `HTTP ${response.status}`
      };
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;
    console.log('[Clanker] Raw LLM response:', rawContent);

    if (!rawContent) {
      return { success: false, error: 'No response from LLM' };
    }

    // Parse JSON response from LLM
    const parsed = parseLLMResponse(rawContent);
    console.log('[Clanker] Parsed response:', parsed);
    return {
      success: true,
      content: parsed.response,
      summary: parsed.summary || null,
      requestImage: parsed.requestImage || null,
      customization: parsed.customization
    };
  } catch (error) {
    // Provide more specific error messages for common failures
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return { success: false, error: 'Network error - check your connection' };
    }
    return { success: false, error: error.message };
  }
}

/**
 * Parse LLM response which should be JSON with response and optional summary
 * Falls back to treating entire content as response if not valid JSON
 */
function parseLLMResponse(content) {
  // Try to parse as JSON
  try {
    // Handle case where LLM wraps JSON in markdown code block
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```json')) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith('```')) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    const parsed = JSON.parse(jsonStr);

    // Check if this looks like a valid structured response
    const hasResponse = typeof parsed.response === 'string' || parsed.response === null;
    const hasRequestImage = typeof parsed.requestImage === 'string';
    const hasSummary = typeof parsed.summary === 'string';
    const hasCustomization = 'customization' in parsed;

    // Accept if it has any of the expected fields
    if (hasResponse || hasRequestImage || hasSummary || hasCustomization) {
      return {
        response: hasResponse ? parsed.response : null,
        summary: hasSummary ? parsed.summary : null,
        requestImage: hasRequestImage ? parsed.requestImage : null,
        customization: hasCustomization ? parsed.customization : undefined
      };
    }
  } catch (e) {
    // Not valid JSON, fall through
  }

  // Fallback: treat entire content as the response
  return { response: content, summary: null, requestImage: null };
}

/**
 * Click an element by ID using main world script injection
 */
async function handleClickElement(tabId, elementId) {
  if (!tabId || !elementId) {
    return { success: false, error: 'Missing tab ID or element ID' };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (id) => {
        const el = document.getElementById(id);
        if (el) {
          el.removeAttribute('id');
          el.click();
          return true;
        }
        return false;
      },
      args: [elementId]
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Send a message by setting textarea value and clicking send - all in main world
 */
async function handleSendMessage(tabId, text) {
  if (!tabId || !text) {
    return { success: false, error: 'Missing tab ID or text' };
  }

  try {
    // Step 1: Set the textarea value using execCommand to simulate real typing
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (messageText) => {
        const textarea = document.querySelector('[data-e2e-message-input-box]');
        if (!textarea) {
          return false;
        }

        // Focus the textarea
        textarea.focus();

        // Clear existing content
        textarea.select();
        document.execCommand('delete', false, null);

        // Insert new text using execCommand (simulates actual typing)
        const inserted = document.execCommand('insertText', false, messageText);

        if (!inserted) {
          // Fallback to native setter
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          nativeSetter.call(textarea, messageText);
        }

        // Dispatch multiple events to ensure Angular picks up the change
        textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));

        return true;
      },
      args: [text]
    });

    // Step 2: Brief wait for Angular to process
    await new Promise(resolve => setTimeout(resolve, 200));

    // Step 3: Use debugger (already attached) to focus textarea and send Enter
    if (!debuggerAttached.has(tabId)) {
      return { success: false, error: 'Debugger not attached - is the extension active?' };
    }

    try {
      // Get document root and find textarea
      const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument');
      const nodeResult = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: '[data-e2e-message-input-box]'
      });

      if (!nodeResult.nodeId) {
        return { success: false, error: 'Could not find message input' };
      }

      // Focus the textarea via CDP
      await chrome.debugger.sendCommand({ tabId }, 'DOM.focus', {
        nodeId: nodeResult.nodeId
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // Send trusted Enter key event to submit the message
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      });

      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      });

      return { success: true };
    } catch (error) {
      // If debugger was detached externally, update our tracking
      if (error.message?.includes('not attached')) {
        debuggerAttached.delete(tabId);
      }
      return { success: false, error: error.message };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get current configuration
 */
async function handleGetConfig() {
  try {
    const config = await Storage.get(Object.values(STORAGE_KEYS));
    return {
      success: true,
      config: {
        hasApiConfig: !!(config[STORAGE_KEYS.API_ENDPOINT] &&
                        config[STORAGE_KEYS.API_KEY] &&
                        config[STORAGE_KEYS.MODEL]),
        userName: config[STORAGE_KEYS.USER_NAME] || null,
        historySize: config[STORAGE_KEYS.HISTORY_SIZE] || 20
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get mode for a tab
 */
async function handleGetMode(tabId) {
  if (!tabId) {
    return { success: false, error: 'No tab ID' };
  }

  // Check if configured
  const config = await Storage.get(Object.values(STORAGE_KEYS));
  const isConfigured = !!(config[STORAGE_KEYS.API_ENDPOINT] &&
                          config[STORAGE_KEYS.API_KEY] &&
                          config[STORAGE_KEYS.MODEL]);

  if (!isConfigured) {
    return { success: true, mode: MODES.UNINITIALIZED };
  }

  const mode = tabModes.get(tabId) || MODES.DEACTIVATED;
  return { success: true, mode };
}

/**
 * Attach debugger to a tab for message sending
 */
async function attachDebugger(tabId) {
  if (debuggerAttached.has(tabId)) {
    console.log('[Clanker] Debugger already attached to tab', tabId);
    return true;
  }

  try {
    console.log('[Clanker] Attaching debugger to tab', tabId);
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached.add(tabId);
    console.log('[Clanker] Debugger attached to tab', tabId);
    return true;
  } catch (error) {
    console.error('[Clanker] Failed to attach debugger:', error);
    return false;
  }
}

/**
 * Detach debugger from a tab
 */
async function detachDebugger(tabId) {
  if (!debuggerAttached.has(tabId)) {
    return true;
  }

  try {
    console.log('[Clanker] Detaching debugger from tab', tabId);
    await chrome.debugger.detach({ tabId });
    debuggerAttached.delete(tabId);
    console.log('[Clanker] Debugger detached from tab', tabId);
    return true;
  } catch (error) {
    console.error('[Clanker] Failed to detach debugger:', error);
    debuggerAttached.delete(tabId); // Remove from set anyway
    return false;
  }
}

/**
 * Set mode for a tab
 */
async function handleSetMode(tabId, mode) {
  if (!tabId) {
    return { success: false, error: 'No tab ID' };
  }

  if (!Object.values(MODES).includes(mode)) {
    return { success: false, error: 'Invalid mode' };
  }

  // Check if configured before allowing non-deactivated modes
  if (mode !== MODES.DEACTIVATED && mode !== MODES.UNINITIALIZED) {
    const config = await Storage.get(Object.values(STORAGE_KEYS));
    const isConfigured = !!(config[STORAGE_KEYS.API_ENDPOINT] &&
                            config[STORAGE_KEYS.API_KEY] &&
                            config[STORAGE_KEYS.MODEL]);

    if (!isConfigured) {
      return { success: false, error: 'Extension not configured', mode: MODES.UNINITIALIZED };
    }
  }

  const oldMode = tabModes.get(tabId) || MODES.DEACTIVATED;
  tabModes.set(tabId, mode);
  await updateContextMenuForTab(tabId);
  await updateToolbarIcon(tabId, mode);

  // Manage debugger attachment based on mode
  if (mode === MODES.ACTIVE || mode === MODES.AVAILABLE) {
    // Attach debugger when entering active modes
    if (oldMode === MODES.DEACTIVATED || oldMode === MODES.UNINITIALIZED) {
      await attachDebugger(tabId);
    }
  }
  // Note: Don't detach debugger here when deactivating - let content script
  // send deactivation message first, then it will request detach

  // Notify the content script
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'MODE_CHANGED', mode });
  } catch (e) {
    // Content script might not be ready
  }

  return { success: true, mode };
}

/**
 * Handle diagnostic: Log conversation state to a new tab
 */
async function handleDiagLog(tabId) {
  try {
    // Request state from content script
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_DIAGNOSTIC_STATE' });

    if (!response?.success) {
      console.error('[Clanker] Failed to get diagnostic state:', response?.error);
      return;
    }

    // Create HTML content for the diagnostic output
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Clanker Diagnostic - Conversation State</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #1e1e1e; color: #d4d4d4; }
    h1 { color: #569cd6; }
    h2 { color: #4ec9b0; margin-top: 30px; }
    pre { background: #2d2d2d; padding: 15px; border-radius: 5px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
    .section { margin-bottom: 20px; }
    .label { color: #9cdcfe; }
    .value { color: #ce9178; }
    .null { color: #808080; font-style: italic; }
  </style>
</head>
<body>
  <h1>Clanker Diagnostic - Conversation State</h1>
  <p>Generated: ${new Date().toISOString()}</p>

  <h2>Runtime State</h2>
  <pre>${escapeHtml(JSON.stringify(response.runtimeState, null, 2))}</pre>

  <h2>Stored Mode</h2>
  <pre>${escapeHtml(JSON.stringify(response.storedMode, null, 2))}</pre>

  <h2>Stored Summary</h2>
  <pre>${response.storedSummary ? escapeHtml(response.storedSummary) : '<span class="null">null</span>'}</pre>

  <h2>Stored Customization</h2>
  <pre>${response.storedCustomization ? escapeHtml(response.storedCustomization) : '<span class="null">null</span>'}</pre>

  <h2>Recent Messages (last 20)</h2>
  <p><em>Note: Images are included in sequence with type "image" or "text+image"</em></p>
  <pre>${escapeHtml(JSON.stringify(response.recentMessages, null, 2))}</pre>
</body>
</html>`;

    // Open in a new tab using data URL
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    chrome.tabs.create({ url: dataUrl });

  } catch (error) {
    console.error('[Clanker] Diagnostic log error:', error);
  }
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return String(text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Handle diagnostic: Deactivate in all conversations
 * Deactivates current conversation with full mode-change processing,
 * then sets all other stored conversation modes to deactivated.
 */
async function handleDiagDeactivateAll(tabId) {
  try {
    // Deactivate current conversation (sends message, detaches debugger, etc.)
    await handleSetMode(tabId, MODES.DEACTIVATED);

    // Set all stored per-conversation modes to deactivated
    const allData = await Storage.getAll();
    const updates = {};
    for (const key of Object.keys(allData)) {
      if (key.startsWith('mode_') && allData[key] !== MODES.DEACTIVATED) {
        updates[key] = MODES.DEACTIVATED;
      }
    }
    if (Object.keys(updates).length > 0) {
      await Storage.set(updates);
      console.log(`[Clanker] Deactivated ${Object.keys(updates).length} other conversation(s)`);
    }

  } catch (error) {
    console.error('[Clanker] Deactivate all error:', error);
  }
}

/**
 * Handle diagnostic: Reset current conversation state
 */
async function handleDiagResetConversation(tabId) {
  try {
    // Tell content script to reset conversation state
    const response = await chrome.tabs.sendMessage(tabId, { type: 'DIAG_RESET_CONVERSATION' });

    if (!response?.success) {
      console.error('[Clanker] Failed to reset conversation:', response?.error);
    }

    // Also set mode to deactivated in background
    await handleSetMode(tabId, MODES.DEACTIVATED);

  } catch (error) {
    console.error('[Clanker] Reset conversation error:', error);
  }
}

/**
 * Handle diagnostic: Reset all state data
 */
async function handleDiagResetAll(tabId) {
  try {
    // Inject a confirmation dialog
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return confirm('Reset ALL Clanker state data?\n\nThis will delete all stored data for all conversations including modes, summaries, and customizations.\n\nConfiguration (API key, model, etc.) will be preserved.\n\nThis action cannot be undone.');
      }
    });

    if (!result?.result) {
      return; // User cancelled
    }

    // Save configuration before clearing
    const configKeys = Object.values(STORAGE_KEYS);
    const savedConfig = await Storage.get(configKeys);

    // Clear all IndexedDB storage
    await Storage.clear();

    // Restore configuration
    const configToRestore = {};
    for (const key of configKeys) {
      if (savedConfig[key] !== undefined) {
        configToRestore[key] = savedConfig[key];
      }
    }
    if (Object.keys(configToRestore).length > 0) {
      await Storage.set(configToRestore);
    }

    // Tell content script to reinitialize
    await chrome.tabs.sendMessage(tabId, { type: 'DIAG_REINITIALIZE' });

    // Set mode to deactivated
    await handleSetMode(tabId, MODES.DEACTIVATED);

    console.log('[Clanker] All state data reset (configuration preserved)');

  } catch (error) {
    console.error('[Clanker] Reset all error:', error);
  }
}

/**
 * Create the context menu structure
 */
function createContextMenu() {
  // Remove existing menus first
  chrome.contextMenus.removeAll(() => {
    // Parent menu
    chrome.contextMenus.create({
      id: MENU_IDS.PARENT,
      title: 'Clanker',
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });

    // Mode: Deactivated
    chrome.contextMenus.create({
      id: MENU_IDS.MODE_DEACTIVATED,
      parentId: MENU_IDS.PARENT,
      title: 'Deactivated',
      type: 'radio',
      checked: true,
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });

    // Mode: Available
    chrome.contextMenus.create({
      id: MENU_IDS.MODE_AVAILABLE,
      parentId: MENU_IDS.PARENT,
      title: 'Available',
      type: 'radio',
      checked: false,
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });

    // Mode: Active
    chrome.contextMenus.create({
      id: MENU_IDS.MODE_ACTIVE,
      parentId: MENU_IDS.PARENT,
      title: 'Active',
      type: 'radio',
      checked: false,
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });

    // Separator
    chrome.contextMenus.create({
      id: MENU_IDS.SEPARATOR,
      parentId: MENU_IDS.PARENT,
      type: 'separator',
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });

    // Settings
    chrome.contextMenus.create({
      id: MENU_IDS.SETTINGS,
      parentId: MENU_IDS.PARENT,
      title: 'Settings...',
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });

    // Separator before diagnostics
    chrome.contextMenus.create({
      id: MENU_IDS.SEPARATOR2,
      parentId: MENU_IDS.PARENT,
      type: 'separator',
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });

    // Diagnostics submenu
    chrome.contextMenus.create({
      id: MENU_IDS.DIAGNOSTICS,
      parentId: MENU_IDS.PARENT,
      title: 'Diagnostics',
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });

    // Diagnostic: Show conversation state
    chrome.contextMenus.create({
      id: MENU_IDS.DIAG_LOG,
      parentId: MENU_IDS.DIAGNOSTICS,
      title: 'Show Conversation State',
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });

    // Diagnostic: Deactivate in all conversations
    chrome.contextMenus.create({
      id: MENU_IDS.DIAG_DEACTIVATE_ALL,
      parentId: MENU_IDS.DIAGNOSTICS,
      title: 'Deactivate In All Conversations',
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });

    // Diagnostic: Reset conversation state
    chrome.contextMenus.create({
      id: MENU_IDS.DIAG_RESET_CONVERSATION,
      parentId: MENU_IDS.DIAGNOSTICS,
      title: 'Purge Conversation State',
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });

    // Diagnostic: Reset all state data
    chrome.contextMenus.create({
      id: MENU_IDS.DIAG_RESET_ALL,
      parentId: MENU_IDS.DIAGNOSTICS,
      title: 'Purge All State Data...',
      contexts: ['page'],
      documentUrlPatterns: ['https://messages.google.com/*']
    });
  });
}

/**
 * Update toolbar icon based on mode for a specific tab
 * Uses disabled icons for Deactivated/Uninitialized, default icons otherwise
 */
async function updateToolbarIcon(tabId, mode) {
  const isActive = mode === MODES.ACTIVE || mode === MODES.AVAILABLE;
  const iconSet = isActive ? ICONS.DEFAULT : ICONS.DISABLED;

  try {
    await chrome.action.setIcon({
      tabId,
      path: iconSet
    });
  } catch (e) {
    // Tab might not exist or be accessible
  }
}

/**
 * Update context menu checkmarks for a specific tab
 */
async function updateContextMenuForTab(tabId) {
  const { mode } = await handleGetMode(tabId);

  // If uninitialized, disable mode options
  const enabled = mode !== MODES.UNINITIALIZED;

  try {
    await chrome.contextMenus.update(MENU_IDS.MODE_DEACTIVATED, {
      checked: mode === MODES.DEACTIVATED || mode === MODES.UNINITIALIZED,
      enabled
    });
    await chrome.contextMenus.update(MENU_IDS.MODE_AVAILABLE, {
      checked: mode === MODES.AVAILABLE,
      enabled
    });
    await chrome.contextMenus.update(MENU_IDS.MODE_ACTIVE, {
      checked: mode === MODES.ACTIVE,
      enabled
    });
  } catch (e) {
    // Menu might not exist yet
  }
}

/**
 * Handle context menu clicks
 */
// addListener is still valid for extensions, it is deprecated for DOM scripts
// noinspection JSDeprecatedSymbols
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  switch (info.menuItemId) {
    case MENU_IDS.MODE_DEACTIVATED:
      await handleSetMode(tab.id, MODES.DEACTIVATED);
      break;

    case MENU_IDS.MODE_AVAILABLE:
      await handleSetMode(tab.id, MODES.AVAILABLE);
      break;

    case MENU_IDS.MODE_ACTIVE:
      await handleSetMode(tab.id, MODES.ACTIVE);
      break;

    case MENU_IDS.SETTINGS:
      // Open the options page in a new tab
      chrome.runtime.openOptionsPage();
      break;

    case MENU_IDS.DIAG_LOG:
      // Show conversation state in a new tab
      handleDiagLog(tab.id);
      break;

    case MENU_IDS.DIAG_DEACTIVATE_ALL:
      // Deactivate in all conversations
      handleDiagDeactivateAll(tab.id);
      break;

    case MENU_IDS.DIAG_RESET_CONVERSATION:
      // Reset current conversation state
      handleDiagResetConversation(tab.id);
      break;

    case MENU_IDS.DIAG_RESET_ALL:
      // Reset all state data (with confirmation)
      handleDiagResetAll(tab.id);
      break;
  }
});

/**
 * Update menu when tab is activated
 */
// addListener is still valid for extensions, it is deprecated for DOM scripts
// noinspection JSDeprecatedSymbols
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await updateContextMenuForTab(activeInfo.tabId);
  // Update toolbar icon to reflect this tab's mode
  const mode = tabModes.get(activeInfo.tabId) || MODES.DEACTIVATED;
  await updateToolbarIcon(activeInfo.tabId, mode);
});

/**
 * Clean up when tab is closed
 */
// addListener is still valid for extensions, it is deprecated for DOM scripts
// noinspection JSDeprecatedSymbols
chrome.tabs.onRemoved.addListener((tabId) => {
  tabModes.delete(tabId);
  debuggerAttached.delete(tabId); // Debugger auto-detaches on tab close
});

/**
 * Handle debugger detach (user cancelled or browser detached)
 */
// noinspection JSDeprecatedSymbols
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  console.log('[Clanker] Debugger detached from tab', tabId, 'reason:', reason);
  debuggerAttached.delete(tabId);

  // If user cancelled, revert to deactivated mode
  if (reason === 'canceled_by_user') {
    tabModes.set(tabId, MODES.DEACTIVATED);
    updateContextMenuForTab(tabId);
    // Notify content script
    chrome.tabs.sendMessage(tabId, { type: 'MODE_CHANGED', mode: MODES.DEACTIVATED }).catch(() => {});
  }
});

/**
 * Handle tab URL changes - detach debugger if navigating away from Google Messages
 */
// noinspection JSDeprecatedSymbols
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && debuggerAttached.has(tabId)) {
    const isGoogleMessages = changeInfo.url.startsWith('https://messages.google.com/');
    if (!isGoogleMessages) {
      console.log('[Clanker] Tab navigated away from Google Messages, detaching debugger');
      await detachDebugger(tabId);
      tabModes.set(tabId, MODES.DEACTIVATED);
    }
  }
});

/**
 * Handle toolbar icon click - open options page
 */
// addListener is still valid for extensions, it is deprecated for DOM scripts
// noinspection JSDeprecatedSymbols
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

/**
 * Handle extension installation
 */
// addListener is still valid for extensions, it is deprecated for DOM scripts
// noinspection JSDeprecatedSymbols
chrome.runtime.onInstalled.addListener((details) => {
  createContextMenu();

  if (details.reason === 'install') {
    console.log('Clanker extension installed');
  } else if (details.reason === 'update') {
    console.log('Clanker extension updated to version', chrome.runtime.getManifest().version);
  }
});

/**
 * Recreate context menu on service worker startup
 */
createContextMenu();
