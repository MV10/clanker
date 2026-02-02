/**
 * Clanker State Module
 * Shared state, constants, and context validation
 */

(function() {
  'use strict';

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
   * Extension state - shared across all content modules
   */
  const state = {
    initialized: false,
    initializing: false,
    mode: MODES.DEACTIVATED,
    conversation: null,     // Current ConversationContext from parser
    conversationSummary: null, // LLM-generated summary of older messages
    conversationCustomization: null, // LLM-managed persona/style customization
    processedMessageIds: new Set(),
    lastMessageTime: 0,
    userTyping: false,
    responseDelayMs: 3000,  // Wait before responding
    pendingResponseTimer: null,
    pendingResponseMessageId: null,
    currentConversationId: null,
    config: null,
    // Concurrency control for LLM requests
    llmRequestId: 0,        // Incremented each time a response is triggered
    llmInFlight: false,     // True while an LLM request is active
    // Conversation change guard
    conversationChanging: false,  // True while switching conversations
    parseComplete: true,          // True after parseExistingConversation completes (default true for normal operation)
    // Last processed message tracking (for detecting new messages on return)
    // Stores {id, content, sender} for hybrid matching
    lastProcessedMessage: null
  };

  /**
   * Default number of recent messages to send literally (not summarized)
   * Can be overridden by config.historySize
   */
  const DEFAULT_HISTORY_SIZE = 20;

  /**
   * Image processing configuration
   * Long edge must be multiple of 448, max 1344 (448 * 3)
   */
  const IMAGE_CONFIG = {
    TILE_SIZE: 448,
    MAX_TILES: 3,
    MAX_DIMENSION: 448 * 3, // 1344
    JPEG_QUALITY: 0.8
  };

  /**
   * Check if extension context is still valid (not invalidated by extension reload)
   * @returns {boolean}
   */
  function isExtensionContextValid() {
    return typeof chrome !== 'undefined' &&
           typeof chrome.runtime !== 'undefined' &&
           typeof chrome.runtime.id !== 'undefined';
  }

  /**
   * Handle invalidated extension context - show notification and stop processing
   * @param {Function} showNotification - Notification function from content-main
   */
  function handleInvalidatedContext(showNotification) {
    console.warn('[Clanker] Extension was reloaded. Please refresh this page.');
    if (showNotification) {
      showNotification('Extension was reloaded. Please refresh this page.', 'info');
    }
    // Prevent further processing
    state.initialized = false;
    state.mode = MODES.DEACTIVATED;
  }

  // Export to window for use by other content modules
  window.ClankerState = {
    MODES,
    state,
    DEFAULT_HISTORY_SIZE,
    IMAGE_CONFIG,
    isExtensionContextValid,
    handleInvalidatedContext
  };

})();
