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
  HISTORY_SIZE: 'historySize',
  SIDEBAR_MODE: 'sidebarMode',
  WEB_SEARCH: 'webSearch',
  NEWS_SEARCH: 'newsSearch',
  NEWS_MAX_SEARCHES: 'newsMaxSearches',
  NEWS_QUIET_START: 'newsQuietStart',
  NEWS_QUIET_STOP: 'newsQuietStop',
  RELAXED_RESPONSIVENESS: 'relaxedResponsiveness'
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
  DIAG_LOG_SANITIZED: 'clanker-diag-log-sanitized',
  DIAG_DEACTIVATE_ALL: 'clanker-diag-deactivate-all',
  DIAG_RESET_CONVERSATION: 'clanker-diag-reset-conversation',
  DIAG_RESET_ALL: 'clanker-diag-reset-all'
};

/**
 * Track current mode per tab
 */
const tabModes = new Map();

/**
 * Track which tabs are viewing an automated-message conversation
 */
const tabAutomated = new Map();

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
      handleSendMessage(sender.tab?.id, message.text, message.typingParams || null).then(sendResponse);
      return true;

    case 'DETACH_DEBUGGER':
      // Content script requests debugger detach (after deactivation message sent)
      detachDebugger(sender.tab?.id).then(() => sendResponse({ success: true }));
      return true;

    case 'SET_AUTOMATED':
      // Content script reports whether current conversation is automated
      if (sender.tab?.id) {
        tabAutomated.set(sender.tab.id, !!message.automated);
        updateContextMenuForTab(sender.tab.id);
      }
      sendResponse({ success: true });
      return false;

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
      const classified = classifyApiError(response.status, errorData);
      return { success: false, error: classified.error };
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
 * Detect API provider from endpoint URL hostname.
 * Used to adapt web search tool format per provider.
 * @param {string} endpoint
 * @returns {string} 'xai' | 'anthropic' | 'openai' | 'generic'
 */
function detectProvider(endpoint) {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    if (host.includes('x.ai') || host.includes('xai')) return 'xai';
    if (host.includes('anthropic') || host.includes('claude')) return 'anthropic';
    if (host.includes('openai')) return 'openai';
    return 'generic';
  } catch {
    return 'generic';
  }
}

/**
 * Get the API URL, accounting for provider-specific endpoint paths.
 * xAI web search requires the Responses API (/responses), not Chat Completions.
 * @param {string} endpoint - Base endpoint URL
 * @param {string} provider - Detected provider
 * @param {boolean} webSearch - Whether web search is enabled
 * @returns {string}
 */
function getApiUrl(endpoint, provider, webSearch) {
  if (provider === 'xai' && webSearch) {
    return `${endpoint}/responses`;
  }
  return `${endpoint}/chat/completions`;
}

/**
 * Build the JSON request body for the LLM API call.
 * Adapts web search format per provider:
 *   xAI:       Responses API with input[] and tools: [{type: "web_search"}]
 *   Anthropic:  tools: [{type: "web_search_20250305", name: "web_search"}]
 *   OpenAI:     web_search_options: {} (top-level parameter)
 *   Generic:    no web search (format unknown)
 * @param {Object} config - Storage configuration
 * @param {Array} apiMessages - Formatted messages array
 * @param {string} provider - Detected provider
 * @returns {Object}
 */
function buildRequestBody(config, apiMessages, provider) {
  const webSearch = !!config[STORAGE_KEYS.WEB_SEARCH];

  // xAI web search uses the Responses API which has a different body format
  if (provider === 'xai' && webSearch) {
    return {
      model: config[STORAGE_KEYS.MODEL],
      input: apiMessages,
      tools: [{ type: 'web_search' }],
      temperature: 0.7
    };
  }

  // Standard Chat Completions body (xAI without search, OpenAI, Anthropic, generic)
  const body = {
    model: config[STORAGE_KEYS.MODEL],
    messages: apiMessages,
    max_tokens: 512,
    temperature: 0.7
  };

  if (webSearch) {
    switch (provider) {
      case 'anthropic':
        body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
        break;
      case 'openai':
        body.web_search_options = {};
        break;
      // generic: omit — unknown format would likely cause errors
    }
  }

  return body;
}

/**
 * Extract text content from an API response, accounting for provider-specific formats.
 * xAI Responses API returns output[] with message items instead of choices[].
 * @param {Object} data - Parsed JSON response
 * @param {string} provider - Detected provider
 * @param {boolean} webSearch - Whether web search is enabled
 * @returns {string|null}
 */
function extractResponseContent(data, provider, webSearch) {
  // xAI Responses API format
  if (provider === 'xai' && webSearch) {
    const output = data.output;
    if (Array.isArray(output)) {
      for (let i = output.length - 1; i >= 0; i--) {
        const item = output[i];
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) {
              return part.text;
            }
          }
        }
      }
    }
    return null;
  }

  // Standard Chat Completions format
  return data.choices?.[0]?.message?.content || null;
}

/**
 * Classify an API HTTP error into a category with a human-readable message.
 * Categories: 'auth', 'quota', 'rate_limit', 'model', 'server', 'unknown'
 * @param {number} status - HTTP status code
 * @param {Object} errorData - Parsed error response body
 * @returns {Object} {success: false, error: string, errorCategory: string}
 */
function classifyApiError(status, errorData) {
  const apiMessage = errorData.error?.message || '';
  const errorType = (errorData.error?.type || '').toLowerCase();
  const errorCode = (errorData.error?.code || '').toLowerCase();

  // Check for quota/billing indicators in the error body (providers vary)
  const isQuotaError = /quota|billing|budget|insufficient.funds|exceeded.*limit|payment.*required/i.test(apiMessage) ||
    /quota|billing|budget|insufficient/i.test(errorType) ||
    /quota|billing|budget|insufficient/i.test(errorCode);

  let category, message;

  switch (status) {
    case 401:
      category = 'auth';
      message = 'Invalid API key. Check your configuration.';
      break;
    case 402:
      category = 'quota';
      message = 'Payment required. Your API billing may need attention.';
      break;
    case 403:
      category = isQuotaError ? 'quota' : 'auth';
      message = isQuotaError
        ? 'API quota exceeded. Check your billing or usage limits.'
        : 'Access denied. Check your API key permissions.';
      break;
    case 404:
      category = 'model';
      message = 'Model or endpoint not found. Check your configuration.';
      break;
    case 429:
      // 429 can be rate limit (transient) or quota exhaustion (persistent)
      category = isQuotaError ? 'quota' : 'rate_limit';
      message = isQuotaError
        ? 'API quota exhausted. Check your billing or usage limits.'
        : 'Rate limited. Too many requests — will retry automatically.';
      break;
    case 500:
    case 502:
    case 503:
      category = 'server';
      message = `API server error (${status}). This is usually temporary.`;
      break;
    default:
      category = 'unknown';
      message = apiMessage || `HTTP ${status}`;
  }

  return { success: false, error: message, errorCategory: category };
}

/**
 * Send conversation to LLM and get response
 */
async function handleLLMRequest({ messages, systemPrompt, summary, customization, profiles, imageData }) {
  console.log('[Clanker] handleLLMRequest called:', {
    messageCount: messages?.length,
    hasSystemPrompt: !!systemPrompt,
    hasSummary: !!summary,
    hasCustomization: !!customization,
    hasProfiles: !!profiles,
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

    // Add participant profiles if available
    if (profiles && typeof profiles === 'object' && Object.keys(profiles).length > 0) {
      apiMessages.push({
        role: 'system',
        content: `[PARTICIPANT PROFILES]\n${JSON.stringify(profiles)}`
      });
    }

    // Add conversation summary if available (provides context for older messages)
    if (summary) {
      apiMessages.push({
        role: 'user',
        content: `[CONVERSATION SUMMARY - older messages not shown]\n${summary}`
      });
    }

    const provider = detectProvider(config[STORAGE_KEYS.API_ENDPOINT]);

    // Add actual image data if this is a follow-up request with image
    if (imageData) {
      // Format varies by provider
      const imageLabel = `[IMAGE DATA for ${imageData.src} - ${imageData.width}x${imageData.height}]`;
      if (provider === 'xai') {
        // xAI uses input_text/input_image with flat image_url string
        apiMessages.push({
          role: 'user',
          content: [
            { type: 'input_text', text: imageLabel },
            { type: 'input_image', image_url: imageData.dataUrl, detail: 'high' }
          ]
        });
      } else {
        // OpenAI / Anthropic / generic use text/image_url with nested object
        apiMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: imageLabel },
            { type: 'image_url', image_url: { url: imageData.dataUrl, detail: 'high' } }
          ]
        });
      }
    }

    // Add recent literal messages (images are inline as [IMAGE: blob:...] format)
    apiMessages.push(...messages);
    const webSearch = !!config[STORAGE_KEYS.WEB_SEARCH];
    const apiUrl = getApiUrl(config[STORAGE_KEYS.API_ENDPOINT], provider, webSearch);

    console.log('[Clanker] Sending API request to:', apiUrl, '(provider:', provider + ')');
    console.log('[Clanker] Using model:', config[STORAGE_KEYS.MODEL]);
    console.log('[Clanker] Total messages in request:', apiMessages.length);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config[STORAGE_KEYS.API_KEY]}`
      },
      body: JSON.stringify(buildRequestBody(config, apiMessages, provider))
    });

    console.log('[Clanker] API response status:', response.status);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[Clanker] API error:', errorData);
      return classifyApiError(response.status, errorData);
    }

    const data = await response.json();
    const rawContent = extractResponseContent(data, provider, webSearch);
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
      customization: parsed.customization,
      profiles: parsed.profiles
    };
  } catch (error) {
    // Provide more specific error messages for common failures
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return { success: false, error: 'Network error — check your connection.', errorCategory: 'network' };
    }
    return { success: false, error: error.message, errorCategory: 'unknown' };
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
    const hasProfiles = 'profiles' in parsed && typeof parsed.profiles === 'object';

    // Accept if it has any of the expected fields
    if (hasResponse || hasRequestImage || hasSummary || hasCustomization || hasProfiles) {
      return {
        response: hasResponse ? parsed.response : null,
        summary: hasSummary ? parsed.summary : null,
        requestImage: hasRequestImage ? parsed.requestImage : null,
        customization: hasCustomization ? parsed.customization : undefined,
        profiles: hasProfiles ? parsed.profiles : undefined
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
 * @param {number} tabId
 * @param {string} text
 * @param {Object|null} typingParams - If provided, simulate per-character typing
 *   { prefixLength: number, perCharDelayMs: number }
 */
async function handleSendMessage(tabId, text, typingParams) {
  if (!tabId || !text) {
    return { success: false, error: 'Missing tab ID or text' };
  }

  try {
    // Step 1: Set the textarea value using execCommand to simulate real typing
    // The MAIN world script checks for user content before clearing
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (messageText, tp) => {
        const textarea = document.querySelector('[data-e2e-message-input-box]');
        if (!textarea) {
          return { success: false, error: 'no_textarea' };
        }

        // Check for user content before clearing
        const existingContent = textarea.value || textarea.textContent || '';
        const trimmed = existingContent.trim();
        const isUIText = /^(SMS|RCS)(\s+(SMS|RCS))*$/i.test(trimmed);
        if (trimmed.length > 0 && !isUIText) {
          return { success: false, error: 'user_typing' };
        }

        // Focus the textarea
        textarea.focus();

        // Clear existing content
        textarea.select();
        document.execCommand('delete', false, null);

        if (tp) {
          // Typing simulation: insert prefix immediately, then type rest char-by-char
          const prefix = messageText.substring(0, tp.prefixLength);
          const rest = messageText.substring(tp.prefixLength);

          if (prefix) {
            document.execCommand('insertText', false, prefix);
          }

          // Return the rest to type char-by-char asynchronously
          return { success: true, typingRest: rest, perCharDelayMs: tp.perCharDelayMs, jitterMinMs: tp.jitterMinMs || 0, jitterMaxMs: tp.jitterMaxMs || 0 };
        }

        // No typing simulation: insert all at once
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

        return { success: true };
      },
      args: [text, typingParams || null]
    });

    const scriptResult = result?.result;

    if (!scriptResult || !scriptResult.success) {
      const err = scriptResult?.error || 'unknown';
      return { success: false, error: err };
    }

    // If typing simulation was requested, run async char-by-char loop
    if (scriptResult.typingRest !== undefined) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (restText, delayMs, jitterMin, jitterMax) => {
          const textarea = document.querySelector('[data-e2e-message-input-box]');
          if (!textarea) return;

          for (let i = 0; i < restText.length; i++) {
            const jitter = jitterMin + Math.random() * (jitterMax - jitterMin);
            await new Promise(r => setTimeout(r, delayMs + jitter));
            textarea.focus();
            document.execCommand('insertText', false, restText[i]);
          }

          // Dispatch events once at end
          textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
        },
        args: [scriptResult.typingRest, scriptResult.perCharDelayMs, scriptResult.jitterMinMs, scriptResult.jitterMaxMs]
      });
    }

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
        historySize: config[STORAGE_KEYS.HISTORY_SIZE] || 20,
        sidebarMode: config[STORAGE_KEYS.SIDEBAR_MODE] || 'ignore',
        newsSearch: !!config[STORAGE_KEYS.NEWS_SEARCH],
        newsMaxSearches: config[STORAGE_KEYS.NEWS_MAX_SEARCHES] || 10,
        newsQuietStart: config[STORAGE_KEYS.NEWS_QUIET_START] ?? 21,
        newsQuietStop: config[STORAGE_KEYS.NEWS_QUIET_STOP] ?? 9,
        relaxedResponsiveness: config[STORAGE_KEYS.RELAXED_RESPONSIVENESS] !== undefined
          ? !!config[STORAGE_KEYS.RELAXED_RESPONSIVENESS] : true
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

  <h2>Stored Profiles</h2>
  <pre>${response.storedProfiles ? escapeHtml(JSON.stringify(response.storedProfiles, null, 2)) : '<span class="null">null</span>'}</pre>

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
 * Show conversation state with sensitive data redacted for safe public sharing
 */
async function handleDiagLogSanitized(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_DIAGNOSTIC_STATE' });

    if (!response?.success) {
      console.error('[Clanker] Failed to get diagnostic state:', response?.error);
      return;
    }

    const sanitized = sanitizeDiagnosticState(response);

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Clanker Diagnostic - Conversation State (Sanitized)</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #1e1e1e; color: #d4d4d4; }
    h1 { color: #569cd6; }
    h2 { color: #4ec9b0; margin-top: 30px; }
    pre { background: #2d2d2d; padding: 15px; border-radius: 5px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
    .section { margin-bottom: 20px; }
    .label { color: #9cdcfe; }
    .value { color: #ce9178; }
    .null { color: #808080; font-style: italic; }
    .notice { background: #3a3d41; border-left: 4px solid #569cd6; padding: 10px 15px; margin-bottom: 20px; }
  </style>
</head>
<body>
  <h1>Clanker Diagnostic - Conversation State (Sanitized)</h1>
  <p>Generated: ${new Date().toISOString()}</p>
  <div class="notice">Participant names, message content, IDs, URLs, and other sensitive data have been redacted. This output is safe to share publicly for support purposes.</div>

  <h2>Runtime State</h2>
  <pre>${escapeHtml(JSON.stringify(sanitized.runtimeState, null, 2))}</pre>

  <h2>Stored Mode</h2>
  <pre>${escapeHtml(JSON.stringify(sanitized.storedMode, null, 2))}</pre>

  <h2>Stored Summary</h2>
  <pre>${sanitized.storedSummary ? escapeHtml(sanitized.storedSummary) : '<span class="null">null</span>'}</pre>

  <h2>Stored Customization</h2>
  <pre>${sanitized.storedCustomization ? escapeHtml(sanitized.storedCustomization) : '<span class="null">null</span>'}</pre>

  <h2>Stored Profiles</h2>
  <pre>${sanitized.storedProfiles ? escapeHtml(JSON.stringify(sanitized.storedProfiles, null, 2)) : '<span class="null">null</span>'}</pre>

  <h2>Recent Messages (last 20)</h2>
  <pre>${escapeHtml(JSON.stringify(sanitized.recentMessages, null, 2))}</pre>
</body>
</html>`;

    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    chrome.tabs.create({ url: dataUrl });

  } catch (error) {
    console.error('[Clanker] Sanitized diagnostic log error:', error);
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
 * Sanitize diagnostic state data for safe public sharing.
 * Builds a consistent name mapping and applies it across all fields.
 */
function sanitizeDiagnosticState(data) {
  const nameMap = new Map();
  let userCounter = 0;
  let phoneCounter = 0;

  function getRedactedName(name) {
    if (!name) return name;
    if (name === 'You') return name; // Already anonymous, skip
    if (nameMap.has(name)) return nameMap.get(name);

    let redacted;
    if (/^\d{1,10}$/.test(name)) {
      phoneCounter++;
      redacted = `(${String(phoneCounter).padStart(3, '0')}) XXX-XXXX`;
    } else {
      userCounter++;
      redacted = `User${String(userCounter).padStart(3, '0')}`;
    }
    nameMap.set(name, redacted);
    return redacted;
  }

  function redactText(text) {
    if (!text || typeof text !== 'string') return text;
    let result = text;
    // Replace participant names in text (longer names first to avoid partial matches).
    // Case-insensitive to catch informal casing in messages and summaries.
    const sortedNames = [...nameMap.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [original, redacted] of sortedNames) {
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), redacted);
    }
    // Redact blob URIs: blob:https://.../<guid> → blob:https://redacted.com/XXXX
    result = result.replace(/blob:https?:\/\/[^/]+\/[a-f0-9-]+/gi, 'blob:https://redacted.com/XXXX');
    // Redact URLs with domains: https://domain.com/... → https://redacted.com/...
    result = result.replace(/(https?:\/\/)([^/\s]+)/g, '$1redacted.com');
    return result;
  }

  // First pass: collect ALL participant names before any redaction.
  // This ensures redactText has the complete nameMap when replacing names in text.

  // Header names, parsed participants, and LLM-view names from the conversation
  if (data.allParticipantNames) {
    for (const name of data.allParticipantNames) {
      if (name) getRedactedName(name);
    }
  }

  // Configured user name (what the LLM uses in summaries instead of "You")
  if (data.configuredUserName) {
    getRedactedName(data.configuredUserName);
  }

  // Message senders (may include names not in header, e.g. "You")
  if (data.recentMessages) {
    for (const msg of data.recentMessages) {
      if (msg.sender) getRedactedName(msg.sender);
    }
  }
  if (data.runtimeState?.lastProcessedMessage?.sender) {
    getRedactedName(data.runtimeState.lastProcessedMessage.sender);
  }
  if (data.storedLastMessage?.sender) {
    getRedactedName(data.storedLastMessage.sender);
  }

  // For multi-word names (e.g. "Josh Smith"), also register individual words
  // so abbreviations or first-name-only references in summaries get redacted.
  // Each sub-word maps to the same redacted label as the full name.
  for (const [fullName, redacted] of [...nameMap.entries()]) {
    const words = fullName.split(/\s+/).filter(w => w.length >= 2);
    if (words.length > 1) {
      for (const word of words) {
        if (!nameMap.has(word)) {
          nameMap.set(word, redacted);
        }
      }
    }
  }

  // Deep clone to avoid modifying originals
  const sanitized = JSON.parse(JSON.stringify(data));

  // Sanitize runtimeState
  if (sanitized.runtimeState) {
    if (sanitized.runtimeState.conversationId) {
      sanitized.runtimeState.conversationId = 'REDACTED';
    }
    if (sanitized.runtimeState.lastProcessedMessage) {
      const lpm = sanitized.runtimeState.lastProcessedMessage;
      if (lpm.sender) lpm.sender = getRedactedName(lpm.sender);
      if (lpm.content) lpm.content = redactText(lpm.content);
      if (lpm.id) lpm.id = 'REDACTED';
    }
  }

  // Sanitize storedLastMessage
  if (sanitized.storedLastMessage) {
    const slm = sanitized.storedLastMessage;
    if (slm.sender) slm.sender = getRedactedName(slm.sender);
    if (slm.content) slm.content = redactText(slm.content);
    if (slm.id) slm.id = 'REDACTED';
  }

  // Sanitize summary, customization, and profiles
  if (sanitized.storedSummary) {
    sanitized.storedSummary = redactText(sanitized.storedSummary);
  }
  if (sanitized.storedCustomization) {
    sanitized.storedCustomization = redactText(sanitized.storedCustomization);
  }
  if (sanitized.storedProfiles && typeof sanitized.storedProfiles === 'object') {
    const redactedProfiles = {};
    for (const [name, notes] of Object.entries(sanitized.storedProfiles)) {
      const redactedName = getRedactedName(name);
      redactedProfiles[redactedName] = typeof notes === 'string' ? redactText(notes) : notes;
    }
    sanitized.storedProfiles = redactedProfiles;
  }

  // Sanitize recent messages
  if (sanitized.recentMessages) {
    for (const msg of sanitized.recentMessages) {
      if (msg.sender) msg.sender = getRedactedName(msg.sender);
      if (msg.content) msg.content = redactText(msg.content);
      if (msg.id) msg.id = 'REDACTED';
      if (msg.imageSrc) {
        msg.imageSrc = msg.imageSrc.replace(/blob:https?:\/\/[^/]+\/[a-f0-9-]+/gi,
          'blob:https://redacted.com/XXXX');
      }
    }
  }

  // Remove metadata fields that were only needed for building nameMap
  delete sanitized.allParticipantNames;
  delete sanitized.configuredUserName;

  return sanitized;
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
 * Handle diagnostic: Purge current conversation state
 * Mode is preserved by the content script — no mode change here.
 */
async function handleDiagResetConversation(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'DIAG_RESET_CONVERSATION' });

    if (!response?.success) {
      console.error('[Clanker] Failed to purge conversation:', response?.error);
    }
  } catch (error) {
    console.error('[Clanker] Purge conversation error:', error);
  }
}

/**
 * Handle diagnostic: Purge all state data
 * Mode is preserved by the content script — no mode change here.
 */
async function handleDiagResetAll(tabId) {
  try {
    // Inject a confirmation dialog
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return confirm('Purge ALL Clanker state data?\n\nThis will delete all stored data for all conversations including summaries, customizations, and profiles.\n\nAI participation mode and configuration (API key, model, etc.) will be preserved.\n\nThis action cannot be undone.');
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

    // Tell content script to reinitialize (it preserves and re-saves current mode)
    await chrome.tabs.sendMessage(tabId, { type: 'DIAG_REINITIALIZE' });

    console.log('[Clanker] All state data purged (configuration preserved)');

  } catch (error) {
    console.error('[Clanker] Purge all error:', error);
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

    // Diagnostic: Show conversation state (sanitized for sharing)
    chrome.contextMenus.create({
      id: MENU_IDS.DIAG_LOG_SANITIZED,
      parentId: MENU_IDS.DIAGNOSTICS,
      title: 'Show Conversation State (Sanitized)',
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
  const isAutomated = tabAutomated.get(tabId) || false;

  // If uninitialized, disable mode options
  const enabled = mode !== MODES.UNINITIALIZED;

  // In automated-message conversations, hide everything except Settings
  const showNonSettings = !isAutomated;

  try {
    await chrome.contextMenus.update(MENU_IDS.MODE_DEACTIVATED, {
      checked: mode === MODES.DEACTIVATED || mode === MODES.UNINITIALIZED,
      enabled,
      visible: showNonSettings
    });
    await chrome.contextMenus.update(MENU_IDS.MODE_AVAILABLE, {
      checked: mode === MODES.AVAILABLE,
      enabled,
      visible: showNonSettings
    });
    await chrome.contextMenus.update(MENU_IDS.MODE_ACTIVE, {
      checked: mode === MODES.ACTIVE,
      enabled,
      visible: showNonSettings
    });
    await chrome.contextMenus.update(MENU_IDS.SEPARATOR, {
      visible: showNonSettings
    });
    await chrome.contextMenus.update(MENU_IDS.SEPARATOR2, {
      visible: showNonSettings
    });
    await chrome.contextMenus.update(MENU_IDS.DIAGNOSTICS, {
      visible: showNonSettings
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

    case MENU_IDS.DIAG_LOG_SANITIZED:
      // Show sanitized conversation state for safe public sharing
      handleDiagLogSanitized(tab.id);
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
  tabAutomated.delete(tabId);
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
