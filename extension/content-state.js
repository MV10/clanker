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
    conversationProfiles: null,      // LLM-managed participant profiles (JSON object keyed by name)
    processedMessageIds: new Set(),
    lastMessageTime: 0,
    userTyping: false,
    responseDelayMinMs: 1500, // Minimum wait before responding
    responseDelayMaxMs: 2000, // Maximum wait before responding
    pendingResponseTimer: null,
    pendingResponseMessageId: null,
    pendingAttemptResponse: null,  // Stored closure for rescheduling on delay extension
    responseTargetTime: 0,         // Timestamp when pending response should fire
    apiRequestStartTime: 0,        // When SEND_TO_LLM was called (for typing delay calc)
    currentConversationId: null,
    config: null,
    // Concurrency control for LLM requests
    llmRequestId: 0,        // Incremented each time a response is triggered
    llmInFlight: false,     // True while an LLM request is active
    sendingMessage: false,  // True while sendMessage is executing (includes typing simulation)
    // Conversation change guard
    conversationChanging: false,  // True while switching conversations
    parseComplete: true,          // True after parseExistingConversation completes (default true for normal operation)
    // Last processed message tracking (for detecting new messages on return)
    // Stores {id, content, sender} for hybrid matching
    lastProcessedMessage: null,
    // Deferred LLM response (stored when conversation changes mid-request)
    deferredResponse: null,
    // Consecutive LLM error tracking (to avoid spamming notifications)
    consecutiveErrors: 0,
    // Idle-time news search timer
    newsCheckTimer: null,
    lastNewsCheckTime: 0,
    // Sidebar conversation monitoring
    sidebar: {
      mode: 'ignore',
      todoQueue: [],                 // conversation IDs to process
      returnToConversationId: null,  // foreground to return to
      isProcessing: false,           // true while navigating sidebar conversations
      currentlyProcessingId: null,   // conversation being processed
      lastActivityTimestamp: 0,      // last user/LLM/message activity
      idleTimeoutMs: 10 * 60 * 1000,
      idleCheckTimer: null,
      pendingSnippets: new Map(),    // conversationId -> last known snippet text
    }
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
