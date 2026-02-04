/**
 * Clanker Messages Module
 * Message processing pipeline
 */

(function() {
  'use strict';

  const Parser = window.ClankerParser;
  const { state, MODES } = window.ClankerState;
  const ConversationStorage = window.ClankerConversationStorage;

  /**
   * Check if user is currently composing a message
   * Checks actual input content rather than relying on cached state
   */
  function isUserTyping() {
    const inputContainer = Parser.getInputField();
    if (!inputContainer) {
      console.log('[Clanker] isUserTyping: no input field found');
      return false;
    }

    // Find the actual editable element (contenteditable div inside the container)
    const editableElement = inputContainer.querySelector('[contenteditable="true"]') || inputContainer;

    // Get just the text content of the editable area
    const content = editableElement.textContent.trim();

    // Filter out known UI text that isn't user input
    const isUIText = /^(SMS|RCS)(\s+(SMS|RCS))*$/i.test(content);
    const isTyping = content.length > 0 && !isUIText;

    console.log('[Clanker] isUserTyping:', isTyping, 'content:', JSON.stringify(content));
    return isTyping;
  }

  /**
   * Process newly added DOM nodes for messages
   * Uses a delay to allow aria-labels to be fully populated by Google Messages
   */
  function processNewNodes(node) {
    // Skip if deactivated, uninitialized, conversation is changing, or parse not complete
    if (state.mode === MODES.DEACTIVATED || state.mode === MODES.UNINITIALIZED ||
        state.conversationChanging || !state.parseComplete) {
      return;
    }

    // Skip sidebar elements
    if (Parser.isInSidebar(node)) {
      return;
    }

    // Find message wrapper elements using parser
    const messageElements = Parser.findMessageElements(node);

    if (messageElements.length > 0) {
      console.log('[Clanker] Found', messageElements.length, 'message wrapper(s) in new DOM node');

      // Delay processing to allow aria-labels to be fully populated
      // Google Messages populates these asynchronously
      setTimeout(() => {
        // Re-check guards inside timeout - state may have changed
        if (state.conversationChanging || !state.parseComplete) {
          console.log('[Clanker] Skipping message processing - conversation change in progress');
          return;
        }
        for (const el of messageElements) {
          processMessage(el);
        }
      }, 500);
    }
  }

  /**
   * Parse existing conversation history
   */
  function parseExistingConversation(retryCount = 0) {
    // Own the parseComplete flag — stays false until we're truly done
    state.parseComplete = false;

    // Use parser to get full conversation context
    state.conversation = Parser.parseConversation();

    // Check for automated-message conversations (participant is a 10-digit number).
    // Use header names first (available before messages load), fall back to parsed participants.
    const headerNames = Parser.extractParticipantNames();
    if (Parser.hasAutomatedParticipant(headerNames) ||
        Parser.hasAutomatedParticipant(state.conversation.participants)) {
      console.log('[Clanker] Automated-message conversation detected, ignoring');
      state.conversation = null;
      state.parseComplete = true;
      chrome.runtime.sendMessage({ type: 'SET_AUTOMATED', automated: true }).catch(() => {});
      return;
    }

    // If no messages found and we haven't retried too many times, try again
    // Large conversations may take several seconds to load from the user's phone
    if (state.conversation.messageCount === 0 && retryCount < 10) {
      console.log(`[Clanker] No messages found yet, retrying... (${retryCount + 1}/10)`);
      setTimeout(() => {
        parseExistingConversation(retryCount + 1);
      }, 1000);
      return;
    }

    // Successfully found a conversation - dismiss any warning banner
    if (state.conversation.messageCount > 0) {
      if (window.ClankerMain && window.ClankerMain.dismissWarning) {
        window.ClankerMain.dismissWarning();
      }
    }

    console.log(`[Clanker] Found ${state.conversation.messageCount} existing messages`);
    if (state.conversation.participants.size > 0) {
      console.log('[Clanker] Participants:', Array.from(state.conversation.participants));
    }
    chrome.runtime.sendMessage({ type: 'SET_AUTOMATED', automated: false }).catch(() => {});

    const messages = state.conversation.messages;

    // Check for new messages since we last viewed this conversation
    if (state.lastProcessedMessage && messages.length > 0) {
      // Try to find the last processed message using hybrid matching
      let lastIndex = -1;

      // First, try to match by ID
      lastIndex = messages.findIndex(m => m.id === state.lastProcessedMessage.id);

      // If ID not found (temp ID may have changed), try content+sender match
      if (lastIndex < 0 && state.lastProcessedMessage.content) {
        console.log('[Clanker] ID not found, trying content+sender match');
        // Search backwards from the end (the message is likely near the end)
        for (let i = messages.length - 1; i >= 0 && i >= messages.length - 20; i--) {
          const msg = messages[i];
          if (msg.content === state.lastProcessedMessage.content &&
              msg.sender === state.lastProcessedMessage.sender) {
            lastIndex = i;
            console.log('[Clanker] Found match by content+sender at index', i);
            break;
          }
        }
      }

      if (lastIndex >= 0) {
        // Found the last processed message, check for new ones after it
        const newMessages = messages.slice(lastIndex + 1);

        if (newMessages.length > 0) {
          console.log(`[Clanker] Found ${newMessages.length} new message(s) since last visit`);

          // Process new messages based on mode
          if (state.mode === MODES.ACTIVE || state.mode === MODES.AVAILABLE) {
            processNewMessagesOnReturn(newMessages);
          }
        }
      } else {
        console.log('[Clanker] Last processed message not found by ID or content, skipping new message check');
      }
    }

    // Mark all existing messages as processed
    for (const msg of messages) {
      state.processedMessageIds.add(msg.id);
    }

    // Save the last message for future hybrid matching
    if (messages.length > 0) {
      ConversationStorage.saveLastProcessedMessage(messages[messages.length - 1]);
    }

    // Check for deferred LLM response from a previous visit to this conversation
    if (state.deferredResponse &&
        state.deferredResponse.conversationId === state.currentConversationId) {
      const deferred = state.deferredResponse;
      state.deferredResponse = null;
      const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
      if (lastMsg && lastMsg.id === deferred.lastMessageId) {
        console.log('[Clanker] Delivering deferred response for:', deferred.conversationId);
        deliverDeferredResponse(deferred);
      } else {
        console.log('[Clanker] Discarding deferred response — new messages arrived');
      }
    }

    state.parseComplete = true;
    console.log('[Clanker] Parse complete');
  }

  /**
   * Process messages that arrived while viewing another conversation
   * @param {ParsedMessage[]} newMessages - Messages that arrived since last visit
   */
  function processNewMessagesOnReturn(newMessages) {
    // Skip only clanker messages - all human messages (including local user) are relevant
    const relevantMessages = newMessages.filter(m => !m.isClanker);

    if (relevantMessages.length === 0) {
      console.log('[Clanker] No relevant new messages to process');
      return;
    }

    // Find the last message that should trigger a response
    let triggerMessage = null;

    if (state.mode === MODES.ACTIVE) {
      // In Active mode, any new human message warrants consulting the LLM
      // The LLM will decide whether to actually respond (can return null)
      triggerMessage = relevantMessages[relevantMessages.length - 1];
    } else if (state.mode === MODES.AVAILABLE) {
      // In Available mode, check if any new message mentions clanker
      for (const msg of relevantMessages) {
        if (Parser.mentionsClanker(msg.content)) {
          triggerMessage = msg;
        }
      }
    }

    if (!triggerMessage) {
      return;
    }

    // Check if the trigger message already has a Clanker response following it
    // This handles the case where temp IDs became permanent IDs while we were away
    const triggerIndex = newMessages.findIndex(m => m.id === triggerMessage.id);
    const messagesAfterTrigger = newMessages.slice(triggerIndex + 1);
    const alreadyResponded = messagesAfterTrigger.some(m => m.isClanker);

    if (alreadyResponded) {
      console.log('[Clanker] Trigger message already has a Clanker response, skipping');
      return;
    }

    console.log('[Clanker] Triggering response to message from while away:', triggerMessage.id);
    // Call scheduleResponse from content-llm module
    if (window.ClankerLLM && window.ClankerLLM.scheduleResponse) {
      window.ClankerLLM.scheduleResponse(triggerMessage);
    }
  }

  /**
   * Process a single message wrapper element
   */
  function processMessage(element) {
    const parsed = Parser.parseMessageElement(element);
    if (!parsed) {
      // Get debug info from child parts
      const textPart = element.querySelector('mws-text-message-part');
      const imagePart = element.querySelector('mws-image-message-part');
      console.log('[Clanker] Could not parse message wrapper:', {
        messageId: element.getAttribute('data-e2e-message-id'),
        hasTextPart: !!textPart,
        textAriaLabel: textPart?.getAttribute('aria-label'),
        hasImagePart: !!imagePart,
        imageAriaLabel: imagePart?.getAttribute('aria-label')
      });
      return;
    }

    // Skip already processed messages
    if (state.processedMessageIds.has(parsed.id)) {
      console.log('[Clanker] Message already processed:', parsed.id);
      return;
    }
    state.processedMessageIds.add(parsed.id);

    // Update last processed message for this conversation
    ConversationStorage.saveLastProcessedMessage(parsed);

    console.log('[Clanker] New message:', parsed);

    // Update conversation context
    if (state.conversation) {
      state.conversation.participants.add(parsed.sender);
    }
    state.lastMessageTime = Date.now();
    if (window.ClankerSidebar) window.ClankerSidebar.updateActivity();

    // Skip our own messages
    if (parsed.isClanker) return;

    // Handle based on mode
    if (state.mode === MODES.ACTIVE) {
      // Active mode: LLM is consulted for all messages and decides whether to respond
      if (window.ClankerLLM && window.ClankerLLM.scheduleResponse) {
        window.ClankerLLM.scheduleResponse(parsed);
      }
    } else if (state.mode === MODES.AVAILABLE) {
      // Available mode: only respond if "clanker" is mentioned
      if (Parser.mentionsClanker(parsed.content)) {
        if (window.ClankerLLM && window.ClankerLLM.scheduleResponse) {
          window.ClankerLLM.scheduleResponse(parsed);
        }
      }
    }
  }

  /**
   * Deliver a deferred LLM response that was stored during a conversation switch
   * @param {Object} deferred - The deferred response object
   */
  function deliverDeferredResponse(deferred) {
    if (deferred.content) {
      if (window.ClankerMain && window.ClankerMain.sendMessage) {
        window.ClankerMain.sendMessage('[clanker] ' + deferred.content);
      }
    }
    if (deferred.summary) {
      ConversationStorage.saveConversationSummary(deferred.summary);
    }
    if (deferred.customization !== undefined) {
      ConversationStorage.saveConversationCustomization(deferred.customization);
    }
  }

  // Export to window for use by other content modules
  window.ClankerMessages = {
    isUserTyping,
    processNewNodes,
    parseExistingConversation,
    processNewMessagesOnReturn,
    processMessage
  };

})();
