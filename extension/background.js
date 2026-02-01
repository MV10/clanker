/**
 * Clanker Background Service Worker
 * Handles LLM API communication and extension lifecycle
 */

const STORAGE_KEYS = {
  API_ENDPOINT: 'apiEndpoint',
  API_KEY: 'apiKey',
  MODEL: 'model',
  USER_NAME: 'userName'
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
 * Context menu item IDs
 */
const MENU_IDS = {
  PARENT: 'clanker-menu',
  MODE_DEACTIVATED: 'clanker-mode-deactivated',
  MODE_ACTIVE: 'clanker-mode-active',
  MODE_AVAILABLE: 'clanker-mode-available',
  SEPARATOR: 'clanker-separator',
  SETTINGS: 'clanker-settings'
};

/**
 * Track current mode per tab
 */
const tabModes = new Map();

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
async function handleLLMRequest({ messages, systemPrompt, images }) {
  try {
    const config = await chrome.storage.local.get(Object.values(STORAGE_KEYS));

    if (!config[STORAGE_KEYS.API_ENDPOINT] ||
        !config[STORAGE_KEYS.API_KEY] ||
        !config[STORAGE_KEYS.MODEL]) {
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

    // Add conversation messages
    // If images are provided and model might support vision, include them
    if (images && images.length > 0) {
      // Add image context to the last user message or create a new one
      const imageDescriptions = images.map((img, i) =>
        `[Image ${i + 1}: ${img.alt}]`
      ).join(' ');

      // Append image context to system prompt or add as user message
      apiMessages.push({
        role: 'user',
        content: `The conversation includes these recent images: ${imageDescriptions}`
      });
    }

    apiMessages.push(...messages);

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
          max_tokens: 256,
          temperature: 0.7
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error?.message || `HTTP ${response.status}`
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return { success: false, error: 'No response from LLM' };
    }

    return { success: true, content };
  } catch (error) {
    // Provide more specific error messages for common failures
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return { success: false, error: 'Network error - check your connection' };
    }
    return { success: false, error: error.message };
  }
}

/**
 * Get current configuration
 */
async function handleGetConfig() {
  try {
    const config = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
    return {
      success: true,
      config: {
        hasApiConfig: !!(config[STORAGE_KEYS.API_ENDPOINT] &&
                        config[STORAGE_KEYS.API_KEY] &&
                        config[STORAGE_KEYS.MODEL]),
        userName: config[STORAGE_KEYS.USER_NAME] || null
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
  const config = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
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
    const config = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
    const isConfigured = !!(config[STORAGE_KEYS.API_ENDPOINT] &&
                            config[STORAGE_KEYS.API_KEY] &&
                            config[STORAGE_KEYS.MODEL]);

    if (!isConfigured) {
      return { success: false, error: 'Extension not configured', mode: MODES.UNINITIALIZED };
    }
  }

  tabModes.set(tabId, mode);
  await updateContextMenuForTab(tabId);

  // Notify the content script
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'MODE_CHANGED', mode });
  } catch (e) {
    // Content script might not be ready
  }

  return { success: true, mode };
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
  });
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
      // Open the popup/settings
      chrome.action.openPopup();
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
});

/**
 * Clean up when tab is closed
 */
// addListener is still valid for extensions, it is deprecated for DOM scripts
// noinspection JSDeprecatedSymbols
chrome.tabs.onRemoved.addListener((tabId) => {
  tabModes.delete(tabId);
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
