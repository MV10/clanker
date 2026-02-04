/**
 * Clanker Popup Script
 * Handles settings configuration and API connection testing
 */

// Storage module is loaded before this script via popup.html
const Storage = window.ClankerStorage;

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
 * DOM Elements
 */
const elements = {
  form: document.getElementById('settings-form'),
  apiEndpoint: document.getElementById('api-endpoint'),
  apiKey: document.getElementById('api-key'),
  model: document.getElementById('model'),
  userName: document.getElementById('user-name'),
  historySize: document.getElementById('history-size'),
  sidebarMode: document.getElementById('sidebar-mode'),
  webSearch: document.getElementById('web-search'),
  newsSearch: document.getElementById('news-search'),
  newsMaxSearches: document.getElementById('news-max-searches'),
  newsQuietStart: document.getElementById('news-quiet-start'),
  newsQuietStop: document.getElementById('news-quiet-stop'),
  relaxedResponsiveness: document.getElementById('relaxed-responsiveness'),
  saveBtn: document.getElementById('save-btn'),
  testBtn: document.getElementById('test-btn'),
  statusBanner: document.getElementById('status-banner'),
  connectionStatus: document.getElementById('connection-status')
};

/**
 * Load saved settings from storage
 */
async function loadSettings() {
  try {
    const result = await Storage.get(Object.values(STORAGE_KEYS));

    if (result[STORAGE_KEYS.API_ENDPOINT]) {
      elements.apiEndpoint.value = result[STORAGE_KEYS.API_ENDPOINT];
    }
    if (result[STORAGE_KEYS.API_KEY]) {
      elements.apiKey.value = result[STORAGE_KEYS.API_KEY];
    }
    if (result[STORAGE_KEYS.MODEL]) {
      elements.model.value = result[STORAGE_KEYS.MODEL];
    }
    if (result[STORAGE_KEYS.USER_NAME]) {
      elements.userName.value = result[STORAGE_KEYS.USER_NAME];
    }
    if (result[STORAGE_KEYS.HISTORY_SIZE]) {
      elements.historySize.value = result[STORAGE_KEYS.HISTORY_SIZE];
    }
    if (result[STORAGE_KEYS.SIDEBAR_MODE]) {
      elements.sidebarMode.value = result[STORAGE_KEYS.SIDEBAR_MODE];
    }
    elements.webSearch.checked = !!result[STORAGE_KEYS.WEB_SEARCH];
    elements.newsSearch.checked = !!result[STORAGE_KEYS.NEWS_SEARCH];
    elements.relaxedResponsiveness.checked = result[STORAGE_KEYS.RELAXED_RESPONSIVENESS] !== undefined
      ? !!result[STORAGE_KEYS.RELAXED_RESPONSIVENESS] : true;
    if (result[STORAGE_KEYS.NEWS_MAX_SEARCHES] !== undefined) {
      elements.newsMaxSearches.value = result[STORAGE_KEYS.NEWS_MAX_SEARCHES];
    }
    if (result[STORAGE_KEYS.NEWS_QUIET_START] !== undefined) {
      elements.newsQuietStart.value = result[STORAGE_KEYS.NEWS_QUIET_START];
    }
    if (result[STORAGE_KEYS.NEWS_QUIET_STOP] !== undefined) {
      elements.newsQuietStop.value = result[STORAGE_KEYS.NEWS_QUIET_STOP];
    }

    updateConnectionStatus();
  } catch (error) {
    console.error('Failed to load settings:', error);
    showBanner('Failed to load settings', 'error');
  }
}

/**
 * Validate API endpoint URL
 */
function validateEndpoint(url) {
  if (!url) {
    return { valid: false, error: 'Endpoint is required' };
  }

  try {
    const parsed = new URL(url);

    // Must be http or https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Endpoint must use http:// or https://' };
    }

    // Warn about http (but allow for local development)
    if (parsed.protocol === 'http:' && !isLocalhost(parsed.hostname)) {
      return { valid: false, error: 'Non-local endpoints must use https://' };
    }

    // Should not have trailing slash (we append /chat/completions)
    if (url.endsWith('/')) {
      return { valid: true, warning: 'Trailing slash will be kept - ensure path is correct' };
    }

    return { valid: true };
  } catch (e) {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Check if hostname is localhost
 */
function isLocalhost(hostname) {
  return hostname === 'localhost' ||
         hostname === '127.0.0.1' ||
         hostname === '::1' ||
         hostname.endsWith('.local');
}

/**
 * Save settings to storage
 */
async function saveSettings(event) {
  event.preventDefault();

  const endpoint = elements.apiEndpoint.value.trim();
  const apiKey = elements.apiKey.value.trim();
  const model = elements.model.value.trim();
  const userName = elements.userName.value.trim();
  const historySize = parseInt(elements.historySize.value, 10) || 20;
  const sidebarMode = elements.sidebarMode.value;
  const webSearch = elements.webSearch.checked;
  const newsSearch = elements.newsSearch.checked;
  const relaxedResponsiveness = elements.relaxedResponsiveness.checked;
  const newsMaxSearches = Math.max(1, Math.min(100, parseInt(elements.newsMaxSearches.value, 10) || 10));
  const newsQuietStart = Math.max(0, Math.min(23, parseInt(elements.newsQuietStart.value, 10) || 21));
  const newsQuietStop = Math.max(0, Math.min(23, parseInt(elements.newsQuietStop.value, 10) || 9));

  // Validate endpoint URL
  const validation = validateEndpoint(endpoint);
  if (!validation.valid) {
    showBanner(validation.error, 'error');
    elements.apiEndpoint.focus();
    return;
  }
  if (validation.warning) {
    console.warn('Endpoint warning:', validation.warning);
  }

  // Clamp history size to valid range
  const clampedHistorySize = Math.max(10, Math.min(500, historySize));

  const settings = {
    [STORAGE_KEYS.API_ENDPOINT]: endpoint,
    [STORAGE_KEYS.API_KEY]: apiKey,
    [STORAGE_KEYS.MODEL]: model,
    [STORAGE_KEYS.USER_NAME]: userName,
    [STORAGE_KEYS.HISTORY_SIZE]: clampedHistorySize,
    [STORAGE_KEYS.SIDEBAR_MODE]: sidebarMode,
    [STORAGE_KEYS.WEB_SEARCH]: webSearch,
    [STORAGE_KEYS.NEWS_SEARCH]: newsSearch,
    [STORAGE_KEYS.RELAXED_RESPONSIVENESS]: relaxedResponsiveness,
    [STORAGE_KEYS.NEWS_MAX_SEARCHES]: newsMaxSearches,
    [STORAGE_KEYS.NEWS_QUIET_START]: newsQuietStart,
    [STORAGE_KEYS.NEWS_QUIET_STOP]: newsQuietStop
  };

  try {
    await Storage.set(settings);
    showBanner('Settings saved successfully', 'success');
    updateConnectionStatus();
  } catch (error) {
    console.error('Failed to save settings:', error);
    showBanner('Failed to save settings', 'error');
  }
}

/**
 * Test API connection
 */
async function testConnection() {
  const endpoint = elements.apiEndpoint.value.trim();
  const apiKey = elements.apiKey.value.trim();
  const model = elements.model.value.trim();

  if (!endpoint || !apiKey || !model) {
    showBanner('Please fill in all API configuration fields', 'error');
    return;
  }

  elements.testBtn.disabled = true;
  elements.testBtn.textContent = 'Testing...';

  try {
    // Send test request via background script
    const response = await chrome.runtime.sendMessage({
      type: 'TEST_CONNECTION',
      payload: { endpoint, apiKey, model }
    });

    if (response.success) {
      showBanner('Connection successful!', 'success');
      setConnectionStatus('connected', 'Connected');
    } else {
      showBanner(`Connection failed: ${response.error}`, 'error');
      setConnectionStatus('error', 'Connection failed');
    }
  } catch (error) {
    console.error('Connection test failed:', error);
    showBanner(`Test failed: ${error.message}`, 'error');
    setConnectionStatus('error', 'Error');
  } finally {
    elements.testBtn.disabled = false;
    elements.testBtn.textContent = 'Test Connection';
  }
}

/**
 * Show status banner
 */
function showBanner(message, type) {
  elements.statusBanner.textContent = message;
  elements.statusBanner.className = `status-banner ${type}`;

  setTimeout(() => {
    elements.statusBanner.classList.add('hidden');
  }, 3000);
}

/**
 * Update connection status display
 */
async function updateConnectionStatus() {
  const result = await Storage.get([
    STORAGE_KEYS.API_ENDPOINT,
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.MODEL
  ]);

  const hasConfig = result[STORAGE_KEYS.API_ENDPOINT] &&
                    result[STORAGE_KEYS.API_KEY] &&
                    result[STORAGE_KEYS.MODEL];

  if (hasConfig) {
    setConnectionStatus('', 'Configured - click Test to verify');
  } else {
    setConnectionStatus('', 'Not configured');
  }
}

/**
 * Set connection status indicator
 */
function setConnectionStatus(state, text) {
  elements.connectionStatus.className = `status-indicator ${state}`;
  const textEl = elements.connectionStatus.querySelector('.text');
  if (textEl) {
    textEl.textContent = text;
  }
}

/**
 * Initialize popup
 */
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  elements.form.addEventListener('submit', saveSettings);
  elements.testBtn.addEventListener('click', testConnection);
});
