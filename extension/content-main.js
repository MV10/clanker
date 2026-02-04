/**
 * Clanker Main Module
 * Initialization, mode handling, diagnostics, and UI
 */

(function() {
  'use strict';

  const Parser = window.ClankerParser;
  const Storage = window.ClankerStorage;
  const { state, MODES } = window.ClankerState;
  const ConversationStorage = window.ClankerConversationStorage;
  const Observers = window.ClankerObservers;
  const LLM = window.ClankerLLM;

  /**
   * Initialize the extension
   */
  async function initialize() {
    // Prevent duplicate initialization (check both flag and in-progress state)
    if (state.initialized || state.initializing) {
      console.log('[Clanker] Already initialized or initializing, skipping');
      return;
    }
    state.initializing = true;

    console.log('[Clanker] Initializing...');

    // Load configuration and mode
    const configResponse = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    if (!configResponse.success) {
      showWarning('Failed to load Clanker configuration');
      state.initializing = false;
      return;
    }

    state.config = configResponse.config;

    // Get current mode from background
    const modeResponse = await chrome.runtime.sendMessage({ type: 'GET_MODE' });
    if (modeResponse.success) {
      state.mode = modeResponse.mode;
    }

    // Check if uninitialized (no config)
    if (!state.config.hasApiConfig) {
      state.mode = MODES.UNINITIALIZED;
      showWarning('Clanker is not configured. Right-click and select Clanker > Settings to configure.');
      // Still initialize observers in case config is added later
    }

    // Set up observers and listeners (do this even if no conversation is active yet)
    Observers.setupMessageObserver();
    Observers.setupInputObserver();
    Observers.setupConversationObserver();
    setupMessageListener();
    Observers.setupVisibilityListener();

    if (window.ClankerSidebar) {
      window.ClankerSidebar.initialize();
    }

    // Try to detect and parse the current conversation.
    // If the DOM isn't ready yet, silently retry at 1s intervals.
    attemptInitialConversationDetection();

    // Notify background that content script is ready
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' });

    state.initializing = false;
    state.initialized = true;
    console.log('[Clanker] Initialized successfully, mode:', state.mode);
  }

  /**
   * Attempt to detect and load the current conversation.
   * If no conversation is found (DOM not ready yet), retries every 1s.
   * Once detected, hands off to handleConversationChange + parseExistingConversation.
   * Does nothing if a conversation was already detected by another path (e.g. conversation observer).
   */
  function attemptInitialConversationDetection() {
    const conversationId = Parser.detectConversationId();
    if (conversationId) {
      console.log('[Clanker] Conversation detected:', conversationId);
      state.conversationChanging = true;
      state.parseComplete = false;
      handleConversationChange(conversationId).then(() => {
        // parseExistingConversation manages state.parseComplete itself
        if (window.ClankerMessages && window.ClankerMessages.parseExistingConversation) {
          window.ClankerMessages.parseExistingConversation();
        }
        state.conversationChanging = false;
      });
      return;
    }

    // No conversation found yet — the user may be on the sidebar without
    // a conversation selected, or the DOM is still loading. Retry silently.
    // The conversation observer will also catch URL-based changes, but this
    // handles the case where the URL already points to a conversation whose
    // DOM elements haven't rendered yet.
    console.log('[Clanker] No conversation detected yet, will retry in 1s');
    setTimeout(() => {
      // Don't retry if a conversation was already picked up by the conversation observer
      if (!state.currentConversationId) {
        attemptInitialConversationDetection();
      }
    }, 1000);
  }

  /**
   * Set up listener for messages from background script
   */
  function setupMessageListener() {
    // addListener is still valid for extensions, it is deprecated for DOM scripts
    // noinspection JSDeprecatedSymbols
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message.type) {
        case 'MODE_CHANGED':
          handleModeChange(message.mode);
          sendResponse({ success: true });
          break;

        case 'GET_DIAGNOSTIC_STATE':
          handleGetDiagnosticState().then(sendResponse);
          return true; // Keep channel open for async response

        case 'DIAG_RESET_CONVERSATION':
          handleDiagResetConversation().then(sendResponse);
          return true;

        case 'DIAG_REINITIALIZE':
          handleDiagReinitialize().then(sendResponse);
          return true;

        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
      return false;
    });
  }

  /**
   * Handle diagnostic: Get current state for logging
   */
  async function handleGetDiagnosticState() {
    try {
      // Get stored data for this conversation
      const modeKey = `mode_${state.currentConversationId}`;
      const summaryKey = `summary_${state.currentConversationId}`;
      const customizationKey = `customization_${state.currentConversationId}`;
      const lastMessageKey = `lastMessage_${state.currentConversationId}`;

      const stored = await Storage.get([modeKey, summaryKey, customizationKey, lastMessageKey]);

      // Get recent messages from parser (images are now included in messages array)
      const context = Parser.parseConversation();
      const recentMessages = context.messages.slice(-20).map(m => ({
        id: m.id,
        sender: m.sender,
        content: m.content,
        type: m.type,
        imageSrc: m.imageSrc,
        isClanker: m.isClanker,
        timestamp: m.timestamp
      }));

      // Collect all known participant names for sanitization support.
      // Multiple sources are merged because the DOM may have unloaded older messages.
      const headerNames = Parser.extractParticipantNames();
      const freshParticipants = context.participants ? Array.from(context.participants) : [];
      const stateParticipants = state.conversation?.participants
        ? Array.from(state.conversation.participants) : [];
      const configuredUserName = state.config?.userName || null;

      // Merge all sources into a deduplicated list
      const allRawNames = [...new Set([...headerNames, ...freshParticipants, ...stateParticipants])];

      // Also build the LLM-view names (with "You" replaced by configured name).
      // This is the exact name set the LLM uses when writing summaries.
      const llmViewNames = configuredUserName
        ? allRawNames.map(n => n === 'You' ? configuredUserName : n)
        : allRawNames;

      return {
        success: true,
        runtimeState: {
          mode: state.mode,
          conversationId: state.currentConversationId,
          initialized: state.initialized,
          processedMessageCount: state.processedMessageIds.size,
          pendingResponse: state.pendingResponseMessageId !== null,
          userTyping: state.userTyping,
          lastProcessedMessage: state.lastProcessedMessage
        },
        storedMode: stored[modeKey] || null,
        storedSummary: stored[summaryKey] || null,
        storedCustomization: stored[customizationKey] || null,
        storedLastMessage: stored[lastMessageKey] || null,
        recentMessages,
        allParticipantNames: [...new Set([...allRawNames, ...llmViewNames])],
        configuredUserName
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle diagnostic: Reset current conversation state
   */
  async function handleDiagResetConversation() {
    try {
      if (!state.currentConversationId) {
        return { success: false, error: 'No conversation active' };
      }

      // Delete stored data for this conversation
      const modeKey = `mode_${state.currentConversationId}`;
      const summaryKey = `summary_${state.currentConversationId}`;
      const customizationKey = `customization_${state.currentConversationId}`;
      const imageCacheKey = `image_cache_${state.currentConversationId}`;
      const lastMessageKey = `lastMessage_${state.currentConversationId}`;

      await Storage.remove(modeKey);
      await Storage.remove(summaryKey);
      await Storage.remove(customizationKey);
      await Storage.remove(imageCacheKey);
      await Storage.remove(lastMessageKey);

      // Reset runtime state
      state.mode = MODES.DEACTIVATED;
      state.conversationSummary = null;
      state.conversationCustomization = null;
      state.lastProcessedMessage = null;
      state.processedMessageIds.clear();
      LLM.cancelPendingResponse();

      // Re-parse the conversation
      if (window.ClankerMessages && window.ClankerMessages.parseExistingConversation) {
        window.ClankerMessages.parseExistingConversation();
      }

      console.log('[Clanker] Conversation state reset');
      showNotification('Conversation state reset', 'success');

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle diagnostic: Reinitialize after full reset
   */
  async function handleDiagReinitialize() {
    try {
      // Reset all runtime state
      state.initialized = false;
      state.initializing = false;
      state.mode = MODES.DEACTIVATED;
      state.conversation = null;
      state.conversationSummary = null;
      state.conversationCustomization = null;
      state.lastProcessedMessage = null;
      state.processedMessageIds.clear();
      state.currentConversationId = null;
      state.llmInFlight = false;
      LLM.cancelPendingResponse();

      // Re-detect conversation and parse
      const conversationId = Parser.detectConversationId();
      if (conversationId) {
        state.currentConversationId = conversationId;
        if (window.ClankerMessages && window.ClankerMessages.parseExistingConversation) {
          window.ClankerMessages.parseExistingConversation();
        }
      }

      state.initialized = true;

      console.log('[Clanker] Reinitialized after full reset');
      showNotification('All state data reset', 'success');

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Handle mode change from context menu
   */
  async function handleModeChange(newMode) {
    const oldMode = state.mode;

    // Ignore if mode hasn't actually changed
    if (oldMode === newMode) {
      console.log(`[Clanker] Mode unchanged: ${newMode}`);
      return;
    }

    state.mode = newMode;
    console.log(`[Clanker] Mode changed: ${oldMode} -> ${newMode}`);

    // Save mode for this conversation
    ConversationStorage.saveConversationMode(newMode);

    // Cancel any pending response when deactivating
    if (newMode === MODES.DEACTIVATED) {
      LLM.cancelPendingResponse();
    }

    // Insert mode change messages into the conversation (no popup notifications for these)
    if (newMode === MODES.DEACTIVATED) {
      // Any mode -> Deactivated: announce and detach debugger
      await sendMessage('[clanker] The AI has been deactivated for this conversation.');
      chrome.runtime.sendMessage({ type: 'DETACH_DEBUGGER' }).catch(() => {});
    } else if (newMode === MODES.ACTIVE) {
      // Any mode -> Active: LLM generates activation message
      LLM.generateActivationMessage();
    } else if (newMode === MODES.AVAILABLE) {
      // Any mode -> Available: static message
      sendMessage('[clanker] AI is available but will only reply if you address it directly by name.');
    }
  }

  /**
   * Handle conversation change - reset state if conversation switched
   */
  async function handleConversationChange(newConversationId) {
    if (state.currentConversationId && state.currentConversationId !== newConversationId) {
      console.log('[Clanker] Conversation changed, resetting state');
      state.conversation = null;
      state.conversationSummary = null;
      state.conversationCustomization = null;
      state.lastProcessedMessage = null;
      state.processedMessageIds.clear();
      LLM.cancelPendingResponse();
    }

    state.currentConversationId = newConversationId;

    // Load stored mode, summary, customization, and last message for this conversation
    try {
      await ConversationStorage.loadConversationMode(showNotification);
      await ConversationStorage.loadConversationSummary();
      await ConversationStorage.loadConversationCustomization();
      await ConversationStorage.loadLastProcessedMessage();
    } catch (e) {
      // Storage may fail if extension context invalidated
      console.warn('[Clanker] Could not load conversation data');
    }
  }

  /**
   * Show warning banner to user with dismiss button
   */
  function showWarning(message) {
    // Remove any existing warning first
    dismissWarning();

    const banner = document.createElement('div');
    banner.className = 'clanker-warning';

    const text = document.createElement('span');
    text.className = 'clanker-warning-text';
    text.textContent = `[Clanker] ${message}`;

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'clanker-warning-dismiss';
    dismissBtn.textContent = '\u2715';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    dismissBtn.addEventListener('click', () => banner.remove());

    banner.appendChild(text);
    banner.appendChild(dismissBtn);
    document.body.appendChild(banner);
    console.warn('[Clanker]', message);
  }

  /**
   * Remove any existing warning banner
   */
  function dismissWarning() {
    const existing = document.querySelector('.clanker-warning');
    if (existing) {
      existing.remove();
    }
  }

  /**
   * Show notification to user
   */
  function showNotification(message, type = 'info') {
    const existing = document.querySelector('.clanker-notification');
    if (existing) {
      existing.remove();
    }

    const notification = document.createElement('div');
    notification.className = `clanker-notification clanker-notification-${type}`;
    notification.textContent = `[Clanker] ${message}`;
    document.body.appendChild(notification);

    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 5000);

    console.log(`[Clanker] Notification (${type}):`, message);
  }

  /**
   * Wait until the message input field is empty (user finished typing).
   * Polls every 500ms, gives up after timeoutMs.
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} true if input cleared, false if timed out
   */
  function waitForInputClear(timeoutMs = 60000) {
    if (!window.ClankerMessages || !window.ClankerMessages.isUserTyping()) {
      return Promise.resolve(true);
    }
    console.log('[Clanker] User is typing, waiting for input to clear before sending');
    return new Promise(resolve => {
      let elapsed = 0;
      const interval = 500;
      const timer = setInterval(() => {
        elapsed += interval;
        if (!window.ClankerMessages.isUserTyping()) {
          clearInterval(timer);
          console.log('[Clanker] Input cleared, proceeding with send');
          resolve(true);
        } else if (elapsed >= timeoutMs) {
          clearInterval(timer);
          console.warn('[Clanker] Timed out waiting for input to clear, sending anyway');
          resolve(false);
        }
      }, interval);
    });
  }

  /**
   * Send a message using main world injection via background script
   * This ensures Angular recognizes the input and click.
   * If the user is typing, waits for the input field to clear first
   * to avoid destroying their in-progress text.
   */
  async function sendMessage(text) {
    // Wait for the user to finish typing before injecting into the input field
    await waitForInputClear();

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEND_CHAT_MESSAGE',
        text: text
      });
      if (!response.success) {
        showNotification('Failed to send message: ' + response.error, 'error');
      }
      return response.success;
    } catch (err) {
      console.error('[Clanker] Send message error:', err);
      showNotification('Failed to send message', 'error');
      return false;
    }
  }

  /**
   * Wait for page to be ready before initializing
   */
  function waitForPageReady() {
    if (Parser.isPageReady()) {
      initialize();
      return;
    }

    const observer = new MutationObserver((mutations, obs) => {
      if (Parser.isPageReady()) {
        obs.disconnect();
        initialize();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // Timeout fallback
    setTimeout(() => {
      observer.disconnect();
      initialize();
    }, 5000);
  }

  // Export to window for use by other content modules
  window.ClankerMain = {
    initialize,
    handleConversationChange,
    handleModeChange,
    showWarning,
    dismissWarning,
    showNotification,
    sendMessage,
    waitForPageReady
  };

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForPageReady);
  } else {
    waitForPageReady();
  }

})();
