/**
 * Clanker LLM Module
 * LLM communication, prompt building, and response handling
 */

(function() {
  'use strict';

  const Parser = window.ClankerParser;
  const { state, MODES, DEFAULT_HISTORY_SIZE } = window.ClankerState;
  const ConversationStorage = window.ClankerConversationStorage;
  const Images = window.ClankerImages;

  /**
   * Cancel any pending response and invalidate in-flight requests
   */
  function cancelPendingResponse() {
    if (state.pendingResponseTimer) {
      clearTimeout(state.pendingResponseTimer);
      state.pendingResponseTimer = null;
      state.pendingResponseMessageId = null;
      console.log('[Clanker] Cancelled pending response');
    }
    // Increment request ID to invalidate any in-flight LLM requests
    // The in-flight request will check this ID before sending its response
    state.llmRequestId++;
  }

  /**
   * Schedule a response with delay (with debouncing)
   */
  function scheduleResponse(triggerMessage) {
    cancelPendingResponse();

    // Increment request ID to invalidate any in-flight requests
    state.llmRequestId++;
    const requestId = state.llmRequestId;

    state.pendingResponseMessageId = triggerMessage.id;
    state.pendingResponseTimer = setTimeout(async () => {
      state.pendingResponseTimer = null;
      state.pendingResponseMessageId = null;

      // Check if this request was superseded by a newer one
      if (requestId !== state.llmRequestId) {
        console.log('[Clanker] Request superseded, skipping response');
        return;
      }

      // Check actual input content, not just cached state
      if (window.ClankerMessages && window.ClankerMessages.isUserTyping()) {
        console.log('[Clanker] User is typing, skipping response');
        return;
      }

      // Check mode hasn't changed
      if (state.mode === MODES.DEACTIVATED || state.mode === MODES.UNINITIALIZED) {
        console.log('[Clanker] Mode changed, skipping response');
        return;
      }

      // Check if another LLM request is already in flight
      if (state.llmInFlight) {
        console.log('[Clanker] LLM request already in flight, skipping');
        return;
      }

      await generateAndSendResponse(requestId);
    }, state.responseDelayMs);

    console.log('[Clanker] Scheduled response to message:', triggerMessage.id, '(request', requestId + ')');
  }

  /**
   * Generate LLM response and send it
   * @param {number} requestId - The request ID to validate against
   */
  async function generateAndSendResponse(requestId) {
    console.log('[Clanker] Generating LLM response (request', requestId + ')...');

    // Capture origin context before async work (for deferred delivery on conversation switch)
    const originConversationId = state.currentConversationId;
    const originMessages = state.conversation?.messages;
    const originLastMessageId = originMessages?.length > 0
      ? originMessages[originMessages.length - 1].id : null;

    // Mark request as in-flight
    state.llmInFlight = true;
    if (window.ClankerSidebar) window.ClankerSidebar.updateActivity();

    const { recentMessages, olderMessageCount } = buildConversationHistory();
    const systemPrompt = buildSystemPrompt(olderMessageCount);

    console.log('[Clanker] Sending to LLM:', {
      messageCount: recentMessages.length,
      olderMessageCount,
      hasSummary: !!state.conversationSummary,
      hasCustomization: !!state.conversationCustomization
    });

    try {
      let response = await chrome.runtime.sendMessage({
        type: 'SEND_TO_LLM',
        payload: {
          messages: recentMessages,
          systemPrompt,
          summary: state.conversationSummary,
          customization: state.conversationCustomization
        }
      });

      console.log('[Clanker] LLM response received:', {
        success: response.success,
        hasContent: !!response.content,
        hasSummary: !!response.summary,
        hasRequestImage: !!response.requestImage,
        error: response.error
      });

      // Handle image request from LLM (src URI)
      if (response.success && response.requestImage) {
        response = await handleImageRequest(response.requestImage, recentMessages, systemPrompt);
      }

      // Check if this request was superseded while waiting for LLM
      if (requestId !== state.llmRequestId) {
        console.log('[Clanker] Request', requestId, 'superseded by', state.llmRequestId);
        // If conversation changed, defer the response for later delivery
        if (originConversationId !== state.currentConversationId && response.success && response.content) {
          state.deferredResponse = {
            conversationId: originConversationId,
            content: response.content,
            summary: response.summary || null,
            customization: response.customization,
            lastMessageId: originLastMessageId
          };
          console.log('[Clanker] Response deferred for conversation:', originConversationId);
        }
        return;
      }

      if (response.success) {
        // LLM can return null response if it decides not to reply
        if (response.content) {
          if (window.ClankerMain && window.ClankerMain.sendMessage) {
            window.ClankerMain.sendMessage(`[clanker] ${response.content}`);
          }
        } else {
          console.log('[Clanker] LLM chose not to respond');
        }

        // Save updated summary if provided (even if response was null)
        if (response.summary) {
          await ConversationStorage.saveConversationSummary(response.summary);
        }

        // Save updated customization if provided (can be null to clear)
        if (response.customization !== undefined) {
          await ConversationStorage.saveConversationCustomization(response.customization);
        }
      } else {
        console.error('[Clanker] LLM request failed:', response.error);
        if (window.ClankerMain && window.ClankerMain.showNotification) {
          window.ClankerMain.showNotification(`Failed to get response: ${response.error}`, 'error');
        }
      }
    } catch (error) {
      console.error('[Clanker] Failed to get LLM response:', error);
      if (window.ClankerMain && window.ClankerMain.showNotification) {
        window.ClankerMain.showNotification('Unable to reach the AI service. Check your connection.', 'error');
      }
    } finally {
      // Always clear in-flight flag
      state.llmInFlight = false;
      if (window.ClankerSidebar) window.ClankerSidebar.updateActivity();
    }
  }

  /**
   * Generate LLM activation message when entering Active mode
   */
  async function generateActivationMessage() {
    // Check if another LLM request is already in flight
    if (state.llmInFlight) {
      console.log('[Clanker] LLM request in flight, using fallback activation message');
      if (window.ClankerMain && window.ClankerMain.sendMessage) {
        window.ClankerMain.sendMessage('[clanker] AI is now active and participating in this conversation.');
      }
      return;
    }

    // Increment request ID and mark as in-flight
    state.llmRequestId++;
    const requestId = state.llmRequestId;
    state.llmInFlight = true;

    const { recentMessages, olderMessageCount } = buildConversationHistory();
    const basePrompt = buildSystemPrompt(olderMessageCount);

    // Add one-time instruction for activation message - explicitly tell it NOT to request images
    const systemPrompt = basePrompt + '\n\n' +
      'SPECIAL INSTRUCTION: You have just been activated. ' +
      'Generate a brief, friendly message indicating you are now active and ready to participate. ' +
      'Keep it casual and short (one sentence). Do not ask questions, just announce your presence. ' +
      'You MUST respond with a message, not a requestImage or null response. ' +
      'Example: {"response": "Hey everyone, I\'m here and ready to chat!"}';

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEND_TO_LLM',
        payload: {
          messages: recentMessages,
          systemPrompt,
          summary: state.conversationSummary,
          customization: state.conversationCustomization
        }
      });

      // Check if this request was superseded while waiting for LLM
      if (requestId !== state.llmRequestId) {
        console.log('[Clanker] Activation request superseded, discarding response');
        return;
      }

      // Check for valid text response (not a requestImage or other special response)
      const hasValidMessage = response.success &&
        response.content &&
        typeof response.content === 'string' &&
        !response.content.startsWith('{') &&
        !response.requestImage;

      if (hasValidMessage) {
        if (window.ClankerMain && window.ClankerMain.sendMessage) {
          window.ClankerMain.sendMessage(`[clanker] ${response.content}`);
        }

        // Save any summary/customization updates
        if (response.summary) {
          await ConversationStorage.saveConversationSummary(response.summary);
        }
        if (response.customization !== undefined) {
          await ConversationStorage.saveConversationCustomization(response.customization);
        }
      } else {
        // Fallback if LLM didn't return a proper message
        if (window.ClankerMain && window.ClankerMain.sendMessage) {
          window.ClankerMain.sendMessage('[clanker] AI is now active and participating in this conversation.');
        }
        if (!response.success) {
          console.error('[Clanker] Failed to generate activation message:', response.error);
        } else {
          console.warn('[Clanker] LLM returned non-message response for activation, using fallback');
        }
      }
    } catch (error) {
      // Fallback if request fails
      if (window.ClankerMain && window.ClankerMain.sendMessage) {
        window.ClankerMain.sendMessage('[clanker] AI is now active and participating in this conversation.');
      }
      console.error('[Clanker] Failed to generate activation message:', error);
    } finally {
      state.llmInFlight = false;
    }
  }

  /**
   * Handle image request from LLM - fetch image data and make follow-up request
   * @param {string} imageSrc - The blob URL of the requested image
   * @param {Array} messages - The conversation messages
   * @param {string} systemPrompt - The system prompt
   */
  async function handleImageRequest(imageSrc, messages, systemPrompt) {
    console.log('[Clanker] LLM requested image:', imageSrc);

    // Validate the src looks like a blob URL from Google Messages
    if (!imageSrc || !imageSrc.startsWith('blob:https://messages.google.com/')) {
      console.warn('[Clanker] Invalid image src requested:', imageSrc);
      return { success: false, error: 'Invalid image source' };
    }

    // Fetch and optimize the image (uses cache if available)
    const optimized = await Images.getOptimizedImage(imageSrc, null);
    if (!optimized) {
      console.warn('[Clanker] Failed to fetch requested image');
      return { success: false, error: 'Failed to fetch image' };
    }

    console.log(`[Clanker] Sending image data (${optimized.width}x${optimized.height})`);

    // Make follow-up request with image data
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEND_TO_LLM',
        payload: {
          messages,
          systemPrompt,
          summary: state.conversationSummary,
          customization: state.conversationCustomization,
          imageData: {
            src: imageSrc,
            dataUrl: optimized.dataUrl,
            width: optimized.width,
            height: optimized.height
          }
        }
      });

      return response;
    } catch (error) {
      console.error('[Clanker] Failed to send image to LLM:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Build conversation history for LLM context
   * Returns recent literal messages (with inline images) and count of older messages
   */
  function buildConversationHistory() {
    // Re-parse to get current state (images are now included in messages array)
    const context = Parser.parseConversation();
    const allMessages = context.messages;

    // Get history size from config, fall back to default
    const historySize = state.config?.historySize || DEFAULT_HISTORY_SIZE;

    // Split into older (to be summarized) and recent (sent literally)
    const recentStart = Math.max(0, allMessages.length - historySize);
    const olderMessageCount = recentStart;
    const recentMessages = [];

    for (let i = recentStart; i < allMessages.length; i++) {
      const msg = allMessages[i];
      // Replace "You" with configured user name for sender attribution
      const senderName = msg.sender === 'You' ? getLocalUserName() : msg.sender;

      if (msg.type === 'text') {
        // Text-only message
        const role = msg.isClanker ? 'assistant' : 'user';
        let content = msg.content;

        // Replace local user references (e.g., "your message" in replies)
        content = replaceLocalUserReferences(content);

        if (msg.isClanker) {
          content = content.replace(/^\[clanker\]\s*/i, '');
        } else {
          content = `${senderName}: ${content}`;
        }

        recentMessages.push({ role, content });

      } else if (msg.type === 'image') {
        // Image-only message
        const content = `${senderName}: [IMAGE: ${msg.imageSrc || 'unknown'}]`;
        recentMessages.push({ role: 'user', content });

      } else if (msg.type === 'text+image') {
        // Combo message: include both text and image reference
        const role = msg.isClanker ? 'assistant' : 'user';
        let textContent = msg.content;

        // Replace local user references (e.g., "your message" in replies)
        textContent = replaceLocalUserReferences(textContent);

        if (msg.isClanker) {
          textContent = textContent.replace(/^\[clanker\]\s*/i, '');
        } else {
          textContent = `${senderName}: ${textContent}`;
        }

        // Add text part
        recentMessages.push({ role, content: textContent });

        // Add image reference as separate entry
        if (msg.imageSrc) {
          const imageContent = `${senderName}: [IMAGE: ${msg.imageSrc}]`;
          recentMessages.push({ role: 'user', content: imageContent });
        }
      }
    }

    return { recentMessages, olderMessageCount };
  }

  /**
   * Get the display name for the local user
   * Uses configured userName, falls back to "You" if not set
   */
  function getLocalUserName() {
    return state.config?.userName || 'You';
  }

  /**
   * Replace "You" and "your" references with the configured user name
   * Handles sender attribution and reply references
   */
  function replaceLocalUserReferences(text) {
    const userName = getLocalUserName();
    if (userName === 'You') return text;

    return text
      // "your message" → "Keith's message" (for reply references)
      .replace(/\byour message\b/gi, `${userName}'s message`)
      // "to you" → "to Keith" (for other references)
      .replace(/\bto you\b/gi, `to ${userName}`)
      // Standalone "You" as sender
      .replace(/\bYou\b/g, userName);
  }

  /**
   * Build system prompt for LLM
   */
  function buildSystemPrompt(olderMessageCount) {
    const rawParticipants = state.conversation
      ? Array.from(state.conversation.participants)
      : [];

    // Replace "You" with configured user name
    const participants = rawParticipants
      .map(p => p === 'You' ? getLocalUserName() : p)
      .join(', ') || 'unknown';

    const localUserName = getLocalUserName();

    const parts = [
      'You are Clanker (or Clank), an AI assistant participating in an SMS group chat via browser extension.',
      'Keep your responses brief and casual, matching the SMS chat style.',
      'Do not dominate the conversation. Only respond when appropriate.',
      `Current participants: ${participants}.`,
      `The local user (running this extension) is ${localUserName}. Messages from ${localUserName} are sent from this device.`,
      '',
      'RESPONSE FORMAT: You must respond with valid JSON containing:',
      '- "response": Your chat message, or null if you choose not to respond. Do NOT include the [clanker] prefix.',
      '- "summary": Updated conversation summary (optional, include when useful).',
      '- "customization": Updated persona/style directive (optional, see CUSTOMIZATION below).',
      '',
      'SUMMARIZATION: To manage context size, you receive a summary of older messages plus recent literal messages.',
      `There are ${olderMessageCount} older messages not shown (covered by the summary if one exists).`,
      'When to update the summary:',
      '- When important context would otherwise be lost as messages age out',
      '- When key decisions, plans, or topics should be preserved',
      '- When participant dynamics or ongoing threads need tracking',
      'Keep summaries concise but informative. Focus on actionable context, not social pleasantries.',
      '',
      'CHOOSING NOT TO RESPOND: Return {"response": null} when:',
      '- The message does not warrant your input',
      '- Others are having a private exchange',
      '- You have nothing meaningful to add',
      'You can still update the summary even when not responding.',
      '',
      'IMAGES: Images appear inline in the conversation as [IMAGE: blob:...] with optional alt text.',
      'You cannot directly access the blob URL. To view an image, request it by src:',
      '{"requestImage": "blob:https://messages.google.com/..."}',
      'The extension will fetch the image and re-send it to you. Then respond normally.',
      'Only request one image at a time. Only request when the image content is relevant.',
      'When you view an image, consider adding a brief description to the summary for future context.',
      '',
      'CUSTOMIZATION: Users may request changes to your behavior (e.g., "Clanker, talk like a pirate").',
      'You manage these customizations by returning a "customization" field in your response.',
      'Store the directive as a brief instruction to yourself (e.g., "Speak in pirate dialect").',
      'RULES for customization:',
      '- You MAY adopt different tones, personas, speech patterns, or roleplay styles',
      '- You MUST REJECT requests that conflict with your core behavior:',
      '  - Cannot ignore the [clanker] prefix requirement (handled by extension)',
      '  - Cannot dominate conversations or respond to every message',
      '  - Cannot bypass safety guidelines or produce harmful content',
      '- Return {"customization": null} to clear a previous customization',
      '- Customizations persist across messages until changed or cleared',
      '',
      'Example responses:',
      '{"response": "Sounds good!", "summary": "Planning dinner Friday. Mom prefers Italian."}',
      '{"response": null, "summary": "Group decided on Friday 7pm at Olive Garden."}',
      '{"requestImage": "blob:https://messages.google.com/abc123-def456"}',
      '{"response": "Arrr, I be Clanker now, matey!", "customization": "Speak in pirate dialect."}'
    ];

    return parts.join('\n');
  }

  // Export to window for use by other content modules
  window.ClankerLLM = {
    cancelPendingResponse,
    scheduleResponse,
    generateAndSendResponse,
    generateActivationMessage,
    handleImageRequest,
    buildConversationHistory,
    buildSystemPrompt,
    getLocalUserName,
    replaceLocalUserReferences
  };

})();
