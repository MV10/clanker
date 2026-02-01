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
  USER_NAME: 'userName'
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

  const settings = {
    [STORAGE_KEYS.API_ENDPOINT]: endpoint,
    [STORAGE_KEYS.API_KEY]: apiKey,
    [STORAGE_KEYS.MODEL]: model,
    [STORAGE_KEYS.USER_NAME]: userName
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
