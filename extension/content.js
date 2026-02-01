/**
 * Clanker Content Script
 * Runs on messages.google.com to monitor and participate in conversations
 *
 * This file handles:
 * - Extension state management
 * - LLM communication
 * - User interaction (sending messages, notifications)
 * - Observers and event handling
 *
 * DOM parsing is delegated to parser.js (ClankerParser)
 */

(function() {
  'use strict';

  // Parser module is loaded before this script via manifest.json
  const Parser = window.ClankerParser;
  const Selectors = window.ClankerSelectors;

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
   * Extension state
   */
  const state = {
    initialized: false,
    mode: MODES.DEACTIVATED,
    conversation: null,     // Current ConversationContext from parser
    processedMessageIds: new Set(),
    lastMessageTime: 0,
    userTyping: false,
    responseDelayMs: 3000,  // Wait before responding
    pendingResponseTimer: null,
    pendingResponseMessageId: null,
    currentConversationId: null,
    config: null
  };

  /**
   * Initialize the extension
   */
  async function initialize() {
    console.log('[Clanker] Initializing...');

    // Load configuration and mode
    const configResponse = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    if (!configResponse.success) {
      showWarning('Failed to load Clanker configuration');
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

    // Verify page structure using parser
    const verification = Parser.verifyPageStructure();
    if (!verification.valid) {
      console.warn('[Clanker] Page structure check failed:', verification.details);
      showWarning('Clanker cannot recognize the page structure. Google Messages may have updated.');
      return;
    }

    // Detect current conversation
    const conversationId = Parser.detectConversationId();
    await handleConversationChange(conversationId);

    // Set up observers and listeners
    setupMessageObserver();
    setupInputObserver();
    setupConversationObserver();
    setupMessageListener();

    // Parse initial conversation
    parseExistingConversation();

    // Notify background that content script is ready
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' });

    state.initialized = true;
    console.log('[Clanker] Initialized successfully, mode:', state.mode);
  }

  /**
   * Set up listener for messages from background script
   */
  function setupMessageListener() {
    // addListener is still valid for extensions, it is deprecated for DOM scripts
    // noinspection JSDeprecatedSymbols
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'MODE_CHANGED') {
        handleModeChange(message.mode);
        sendResponse({ success: true });
      }
      return false;
    });
  }

  /**
   * Handle mode change from context menu
   */
  function handleModeChange(newMode) {
    const oldMode = state.mode;
    state.mode = newMode;

    console.log(`[Clanker] Mode changed: ${oldMode} -> ${newMode}`);

    // Cancel any pending response when deactivating
    if (newMode === MODES.DEACTIVATED) {
      cancelPendingResponse();
    }

    // Show notification for mode changes
    switch (newMode) {
      case MODES.ACTIVE:
        showNotification('Active mode - AI will participate in the conversation', 'info');
        break;
      case MODES.AVAILABLE:
        showNotification('Available mode - AI will respond when mentioned', 'info');
        break;
      case MODES.DEACTIVATED:
        showNotification('Deactivated - AI is not monitoring this conversation', 'info');
        break;
    }
  }

  /**
   * Handle conversation change - reset state if conversation switched
   */
  async function handleConversationChange(newConversationId) {
    if (state.currentConversationId && state.currentConversationId !== newConversationId) {
      console.log('[Clanker] Conversation changed, resetting state');
      state.conversation = null;
      state.processedMessageIds.clear();
      cancelPendingResponse();

      // Reset mode to deactivated for new conversations
      state.mode = MODES.DEACTIVATED;
      await chrome.runtime.sendMessage({ type: 'SET_MODE', mode: MODES.DEACTIVATED });
    }

    state.currentConversationId = newConversationId;
  }

  /**
   * Set up observer to detect conversation switches
   */
  function setupConversationObserver() {
    let lastUrl = window.location.href;

    const urlObserver = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        const newConversationId = Parser.detectConversationId();
        if (newConversationId !== state.currentConversationId) {
          handleConversationChange(newConversationId);
          parseExistingConversation();
        }
      }
    });

    urlObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    window.addEventListener('popstate', () => {
      const newConversationId = Parser.detectConversationId();
      if (newConversationId !== state.currentConversationId) {
        handleConversationChange(newConversationId);
        parseExistingConversation();
      }
    });
  }

  /**
   * Cancel any pending response
   */
  function cancelPendingResponse() {
    if (state.pendingResponseTimer) {
      clearTimeout(state.pendingResponseTimer);
      state.pendingResponseTimer = null;
      state.pendingResponseMessageId = null;
      console.log('[Clanker] Cancelled pending response');
    }
  }

  /**
   * Show warning banner to user
   */
  function showWarning(message) {
    const banner = document.createElement('div');
    banner.className = 'clanker-warning';
    banner.textContent = `[Clanker] ${message}`;
    document.body.appendChild(banner);
    console.warn('[Clanker]', message);
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
   * Set up MutationObserver to watch for new messages
   */
  function setupMessageObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              processNewNodes(node);
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    console.log('[Clanker] Message observer started');
  }

  /**
   * Set up observer for user typing in input field
   */
  function setupInputObserver() {
    const inputSelector = `${Selectors.INPUT_FIELD}, ${Selectors.INPUT_BOX}`;

    document.addEventListener('input', (event) => {
      const target = event.target;
      if (target.matches && target.matches(inputSelector)) {
        state.userTyping = target.textContent.trim().length > 0;
      }
    }, true);

    document.addEventListener('focusin', (event) => {
      if (event.target.matches && event.target.matches(inputSelector)) {
        state.userTyping = true;
      }
    }, true);

    document.addEventListener('focusout', (event) => {
      if (event.target.matches && event.target.matches(inputSelector)) {
        state.userTyping = event.target.textContent.trim().length > 0;
      }
    }, true);
  }

  /**
   * Process newly added DOM nodes for messages
   */
  function processNewNodes(node) {
    // Skip if deactivated or uninitialized
    if (state.mode === MODES.DEACTIVATED || state.mode === MODES.UNINITIALIZED) {
      return;
    }

    // Skip sidebar elements
    if (Parser.isInSidebar(node)) {
      return;
    }

    // Find message elements using parser
    const messageElements = Parser.findMessageElements(node);

    for (const el of messageElements) {
      processMessage(el);
    }
  }

  /**
   * Parse existing conversation history
   */
  function parseExistingConversation() {
    // Use parser to get full conversation context
    state.conversation = Parser.parseConversation();

    console.log(`[Clanker] Found ${state.conversation.messageCount} existing messages`);
    console.log('[Clanker] Participants:', Array.from(state.conversation.participants));

    // Mark all existing messages as processed
    for (const msg of state.conversation.messages) {
      state.processedMessageIds.add(msg.id);
    }
  }

  /**
   * Process a single message element
   */
  function processMessage(element) {
    const parsed = Parser.parseMessageElement(element);
    if (!parsed) return;

    // Skip already processed messages
    if (state.processedMessageIds.has(parsed.id)) return;
    state.processedMessageIds.add(parsed.id);

    console.log('[Clanker] New message:', parsed);

    // Update conversation context
    if (state.conversation) {
      state.conversation.participants.add(parsed.sender);
    }
    state.lastMessageTime = Date.now();

    // Skip our own messages
    if (parsed.isClanker) return;

    // Handle based on mode
    if (state.mode === MODES.ACTIVE) {
      // Active mode: respond to questions or direct address
      if (shouldRespondActive(parsed)) {
        scheduleResponse(parsed);
      }
    } else if (state.mode === MODES.AVAILABLE) {
      // Available mode: only respond if "clanker" is mentioned
      if (Parser.mentionsClanker(parsed.content)) {
        scheduleResponse(parsed);
      }
    }
  }

  /**
   * Determine if we should respond in Active mode
   */
  function shouldRespondActive(message) {
    // Always respond if Clanker is mentioned
    if (Parser.mentionsClanker(message.content)) {
      return true;
    }

    // Respond to questions
    if (message.content.includes('?')) {
      return true;
    }

    return false;
  }

  /**
   * Schedule a response with delay (with debouncing)
   */
  function scheduleResponse(triggerMessage) {
    cancelPendingResponse();

    state.pendingResponseMessageId = triggerMessage.id;
    state.pendingResponseTimer = setTimeout(async () => {
      state.pendingResponseTimer = null;
      state.pendingResponseMessageId = null;

      if (state.userTyping) {
        console.log('[Clanker] User is typing, skipping response');
        return;
      }

      // Check mode hasn't changed
      if (state.mode === MODES.DEACTIVATED || state.mode === MODES.UNINITIALIZED) {
        console.log('[Clanker] Mode changed, skipping response');
        return;
      }

      await generateAndSendResponse(triggerMessage);
    }, state.responseDelayMs);

    console.log('[Clanker] Scheduled response to message:', triggerMessage.id);
  }

  /**
   * Generate LLM response and send it
   */
  async function generateAndSendResponse(triggerMessage) {
    const messages = buildConversationHistory();
    const systemPrompt = buildSystemPrompt();
    const images = Parser.getRecentImages(3);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEND_TO_LLM',
        payload: { messages, systemPrompt, images }
      });

      if (response.success && response.content) {
        sendMessage(`[clanker] ${response.content}`);
      } else {
        console.error('[Clanker] LLM request failed:', response.error);
        showNotification(`Failed to get response: ${response.error}`, 'error');
      }
    } catch (error) {
      console.error('[Clanker] Failed to get LLM response:', error);
      showNotification('Unable to reach the AI service. Check your connection.', 'error');
    }
  }

  /**
   * Build conversation history for LLM context
   */
  function buildConversationHistory() {
    const messages = [];

    // Re-parse to get current state
    const context = Parser.parseConversation();
    const recentMessages = context.messages.slice(-20);

    for (const parsed of recentMessages) {
      const role = parsed.isClanker ? 'assistant' : 'user';
      let content = parsed.content;

      if (parsed.isClanker) {
        content = content.replace(/^\[clanker\]\s*/i, '');
      } else {
        content = `${parsed.sender}: ${content}`;
      }

      messages.push({ role, content });
    }

    return messages;
  }

  /**
   * Build system prompt for LLM
   */
  function buildSystemPrompt() {
    const participants = state.conversation
      ? Array.from(state.conversation.participants).join(', ')
      : 'unknown';

    const parts = [
      'You are Clanker, an AI assistant participating in an SMS group chat.',
      'Keep your responses brief and casual, matching the SMS chat style.',
      'Do not dominate the conversation. Only respond when appropriate.',
      'Your messages will be prefixed with [clanker] automatically.',
      `Current participants: ${participants}.`
    ];

    return parts.join(' ');
  }

  /**
   * Send a message using the page's input field
   */
  function sendMessage(text) {
    const inputField = Parser.getInputField();
    const sendButton = Parser.getSendButton();

    if (!inputField) {
      console.error('[Clanker] Cannot find input field');
      return;
    }

    // Set input field content
    inputField.focus();
    inputField.textContent = text;

    // Dispatch input event to trigger framework updates
    inputField.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    }));

    inputField.dispatchEvent(new Event('change', { bubbles: true }));

    console.log('[Clanker] Sending message:', text);

    // Click send button or press Enter
    if (sendButton) {
      setTimeout(() => {
        sendButton.click();
        console.log('[Clanker] Clicked send button');
      }, 150);
    } else {
      setTimeout(() => {
        inputField.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true
        }));
        console.log('[Clanker] Pressed Enter key');
      }, 150);
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

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForPageReady);
  } else {
    waitForPageReady();
  }

})();
