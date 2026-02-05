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
      state.pendingAttemptResponse = null;
      state.responseTargetTime = 0;
      console.log('[Clanker] Cancelled pending response');
    }
    // Increment request ID to invalidate any in-flight LLM requests
    // The in-flight request will check this ID before sending its response
    state.llmRequestId++;
  }

  /**
   * Calculate human-like reading delay for a message
   * @param {Object} message - Message with type and content
   * @returns {number} Delay in milliseconds
   */
  function calculateReadingDelay(message) {
    let delayMs = 0;
    if (message.type === 'image' || message.type === 'text+image') {
      delayMs += 500 + Math.random() * 500;  // 500-1000ms for images
    }
    if (message.content && message.type !== 'image') {
      const charsPerSec = 18 + Math.random() * 5;  // 18-23 cps reading speed
      delayMs += (message.content.length / charsPerSec) * 1000;
    }
    return delayMs;
  }

  /**
   * Schedule a response with delay (with debouncing)
   * Three paths:
   *   A) Sidebar "process" mode — fire immediately
   *   B) Extend existing delay — add reading time for new message
   *   C) Fresh schedule — new timer with reading delay or flat delay
   */
  function scheduleResponse(triggerMessage) {
    const relaxed = !!state.config?.relaxedResponsiveness;

    // Path A: Sidebar "process" mode — skip all delays, fire immediately
    if (state.sidebar.isProcessing && state.sidebar.mode === 'process') {
      cancelPendingResponse();
      state.llmRequestId++;
      const requestId = state.llmRequestId;
      state.pendingResponseMessageId = triggerMessage.id;

      // Fire immediately (still async to avoid blocking)
      const attemptResponse = async () => {
        state.pendingResponseTimer = null;
        state.pendingResponseMessageId = null;
        state.pendingAttemptResponse = null;

        if (requestId !== state.llmRequestId) return;
        if (state.mode === MODES.DEACTIVATED || state.mode === MODES.UNINITIALIZED) return;

        if (state.llmInFlight) {
          state.pendingResponseTimer = setTimeout(attemptResponse, 500);
          return;
        }

        await generateAndSendResponse(requestId);
      };

      state.pendingResponseTimer = setTimeout(attemptResponse, 0);
      console.log('[Clanker] Scheduled immediate response (process mode):', triggerMessage.id);
      return;
    }

    // Path B: Extend existing delay when relaxed mode is ON and a timer is pending
    // Cap total accumulated delay at 15 seconds from now to prevent runaway accumulation
    if (relaxed && state.pendingResponseTimer && state.pendingAttemptResponse) {
      const additional = calculateReadingDelay(triggerMessage);
      state.responseTargetTime += additional;
      const maxTargetTime = Date.now() + 15000;
      if (state.responseTargetTime > maxTargetTime) {
        state.responseTargetTime = maxTargetTime;
      }
      clearTimeout(state.pendingResponseTimer);
      const remaining = Math.max(0, state.responseTargetTime - Date.now());
      state.pendingResponseTimer = setTimeout(state.pendingAttemptResponse, remaining);
      console.log('[Clanker] Extended response delay by', Math.round(additional) + 'ms, remaining:', Math.round(remaining) + 'ms');
      return;
    }

    // Path C: Fresh schedule
    cancelPendingResponse();

    state.llmRequestId++;
    const requestId = state.llmRequestId;

    state.pendingResponseMessageId = triggerMessage.id;

    let delay;
    if (relaxed) {
      delay = Math.max(800, calculateReadingDelay(triggerMessage));  // min 800ms floor
    } else {
      delay = state.responseDelayMinMs + Math.random() * (state.responseDelayMaxMs - state.responseDelayMinMs);
    }

    const attemptResponse = async () => {
      state.pendingResponseTimer = null;
      state.pendingResponseMessageId = null;
      state.pendingAttemptResponse = null;

      // Check if this request was superseded by a newer one
      if (requestId !== state.llmRequestId) {
        console.log('[Clanker] Request superseded, skipping response');
        return;
      }

      // Check actual input content, not just cached state.
      // Skip this check if the extension itself is sending a message (typing simulation
      // puts content in the textarea that isUserTyping would misidentify as user input).
      if (!state.sendingMessage && window.ClankerMessages && window.ClankerMessages.isUserTyping()) {
        console.log('[Clanker] User is typing, skipping response');
        return;
      }

      // Check mode hasn't changed
      if (state.mode === MODES.DEACTIVATED || state.mode === MODES.UNINITIALIZED) {
        console.log('[Clanker] Mode changed, skipping response');
        return;
      }

      // If another LLM request is in flight, wait for it to complete.
      // The retry timer is stored in pendingResponseTimer so cancelPendingResponse
      // will clear it if a newer message arrives (newer message takes priority).
      if (state.llmInFlight) {
        console.log('[Clanker] LLM request in flight, will retry after completion');
        state.pendingResponseTimer = setTimeout(attemptResponse, 500);
        return;
      }

      await generateAndSendResponse(requestId);
    };

    state.responseTargetTime = Date.now() + delay;
    state.pendingAttemptResponse = attemptResponse;  // store for Path B reuse
    state.pendingResponseTimer = setTimeout(attemptResponse, delay);

    console.log('[Clanker] Scheduled response to message:', triggerMessage.id, '(request', requestId + ', delay', Math.round(delay) + 'ms)');
  }

  /**
   * Generate LLM response and send it
   * @param {number} requestId - The request ID to validate against
   */
  async function generateAndSendResponse(requestId) {
    console.log('[Clanker] Generating LLM response (request', requestId + ')...');

    // Capture origin conversation before async work (for deferred delivery on conversation switch)
    const originConversationId = state.currentConversationId;

    // Mark request as in-flight
    state.llmInFlight = true;
    if (window.ClankerSidebar) window.ClankerSidebar.updateActivity();

    // Fresh DOM parse — lastMessageId reflects actual current state, not the
    // potentially stale state.conversation.messages from initial parse
    const { recentMessages, olderMessageCount, lastMessageId } = buildConversationHistory();
    const originLastMessageId = lastMessageId;
    const systemPrompt = buildSystemPrompt(olderMessageCount);

    console.log('[Clanker] Sending to LLM:', {
      messageCount: recentMessages.length,
      olderMessageCount,
      hasSummary: !!state.conversationSummary,
      hasCustomization: !!state.conversationCustomization
    });

    // Record when the API request starts (for typing delay calculation)
    state.apiRequestStartTime = Date.now();

    try {
      let response = await chrome.runtime.sendMessage({
        type: 'SEND_TO_LLM',
        payload: {
          messages: recentMessages,
          systemPrompt,
          summary: state.conversationSummary,
          customization: state.conversationCustomization,
          profiles: state.conversationProfiles
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

      // LLM API call is complete — clear in-flight flag before delivery.
      // sendMessage may wait for the user to finish typing, and we must not
      // block new requests (via the llmInFlight retry loop) during that wait.
      state.llmInFlight = false;
      if (window.ClankerSidebar) window.ClankerSidebar.updateActivity();

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
            profiles: response.profiles,
            lastMessageId: originLastMessageId
          };
          console.log('[Clanker] Response deferred for conversation:', originConversationId);
        }
        return;
      }

      if (response.success) {
        // Reset consecutive error counter on success
        state.consecutiveErrors = 0;

        // LLM can return null response if it decides not to reply
        if (response.content) {
          if (window.ClankerMain && window.ClankerMain.sendMessage) {
            // Calculate typing simulation params if relaxed mode is on
            const relaxed = !!state.config?.relaxedResponsiveness;
            const skipTyping = state.sidebar.isProcessing && state.sidebar.mode === 'process';

            let typingParams = null;
            if (relaxed && !skipTyping && response.content) {
              const contentLength = response.content.length;
              const charsPerSec = 350 + Math.random() * 100;  // 350-450 cps (high, but jitter will slow it)
              let typingMs = (contentLength / charsPerSec) * 1000;
              typingMs = Math.min(typingMs, 8000);  // Cap at 8 seconds
              const perCharDelayMs = contentLength > 0 ? typingMs / contentLength : 0;
              if (perCharDelayMs > 0.5) {
                typingParams = { prefixLength: '[clanker] '.length, perCharDelayMs, jitterMinMs: 1, jitterMaxMs: 150 };
              }
            }

            await window.ClankerMain.sendMessage(`[clanker] ${response.content}`, typingParams);
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

        // Save updated profiles if provided
        if (response.profiles !== undefined) {
          await ConversationStorage.saveConversationProfiles(response.profiles);
        }
      } else {
        handleLLMError(response.error, response.errorCategory);
      }
    } catch (error) {
      console.error('[Clanker] Failed to get LLM response:', error);
      handleLLMError('Unable to reach the AI service. Check your connection.', 'network');
    } finally {
      // Safety net — normally cleared above after the API call completes,
      // but ensure it's cleared on early returns and exceptions too
      state.llmInFlight = false;
    }
  }

  /**
   * Handle LLM API errors based on category.
   * - quota/auth: auto-deactivate to stop wasting requests
   * - rate_limit: log only (transient, next message will retry)
   * - server/network: show notification on first occurrence, suppress repeats
   * - model/unknown: always show notification
   * @param {string} errorMessage - Human-readable error message
   * @param {string} category - Error category from background script
   */
  function handleLLMError(errorMessage, category) {
    state.consecutiveErrors++;
    console.error('[Clanker] LLM error (category:', category + ', consecutive:', state.consecutiveErrors + '):', errorMessage);

    if (category === 'quota' || category === 'auth') {
      // Fatal for this session — auto-deactivate to stop burning requests.
      // Set mode directly instead of going through handleModeChange, because
      // that would try to send a deactivation SMS (which would also fail).
      state.mode = MODES.DEACTIVATED;
      cancelPendingResponse();
      ConversationStorage.saveConversationMode(MODES.DEACTIVATED);
      chrome.runtime.sendMessage({ type: 'SET_MODE', mode: MODES.DEACTIVATED }).catch(() => {});
      if (window.ClankerMain) {
        window.ClankerMain.showWarning(errorMessage + ' Clanker has been deactivated.');
      }
      state.consecutiveErrors = 0;
    } else if (category === 'rate_limit') {
      // Transient — just log, next scheduled response will retry naturally
      console.log('[Clanker] Rate limited, will retry on next message');
    } else if (category === 'server' || category === 'network') {
      // Transient — show notification only on first occurrence to avoid spam
      if (state.consecutiveErrors <= 1 && window.ClankerMain) {
        window.ClankerMain.showNotification(errorMessage, 'error');
      }
    } else {
      // model, unknown — always show
      if (window.ClankerMain) {
        window.ClankerMain.showNotification(errorMessage, 'error');
      }
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
          customization: state.conversationCustomization,
          profiles: state.conversationProfiles
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
        state.consecutiveErrors = 0;

        if (window.ClankerMain && window.ClankerMain.sendMessage) {
          window.ClankerMain.sendMessage(`[clanker] ${response.content}`);
        }

        // Save any summary/customization/profile updates
        if (response.summary) {
          await ConversationStorage.saveConversationSummary(response.summary);
        }
        if (response.customization !== undefined) {
          await ConversationStorage.saveConversationCustomization(response.customization);
        }
        if (response.profiles !== undefined) {
          await ConversationStorage.saveConversationProfiles(response.profiles);
        }
      } else if (!response.success && (response.errorCategory === 'quota' || response.errorCategory === 'auth')) {
        // Fatal API error during activation — deactivate instead of sending fallback
        handleLLMError(response.error, response.errorCategory);
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

    // Track last message ID for deferred response matching
    const lastMessageId = allMessages.length > 0
      ? allMessages[allMessages.length - 1].id : null;

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

    return { recentMessages, olderMessageCount, lastMessageId };
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
      'However, you MUST always reply when you are directly addressed by name (Clanker or Clank).',
      'The requirement to reply when addressed remains true after analyzing any requested image content.',
      '',
      `Current participants: ${participants}.`,
      `The local user (running this extension) is ${localUserName}. Messages from ${localUserName} are sent from this device.`,
      '',
      'TEXT FORMATTING: SMS does not support markdown, HTML, or rich text. Use only plain text and emojis.',
      'Do not use asterisks for bold/italic, backticks for code, hash marks for headers, or any other markdown syntax.',
      'Do not include citation data at the end of your replies.',  
      'Only write plain, conversational text. Emojis are fine in moderation but avoid long sequences of them.',
      'Do not use SMS language, textese, txt-speak, texting abbreviations (such as "u" for "you", "ur" for "your", "b4" for "before", "gr8" for "great"), acronyms, or informal shortenings.',
      '',
      'TEXT RESPONSE FORMAT: You must respond with valid JSON containing only these fields:',
      '- "response": Your TEXT-ONLY message, or null if you choose not to respond. Do NOT include the [clanker] prefix. Do not include any internal JSON data.',
      '- "summary": Updated conversation summary (optional, include when useful).',
      '- "customization": Updated persona/style directive (optional, see CUSTOMIZATION below).',
      '- "profiles": Updated participant profiles object (optional, see PARTICIPANT PROFILES below).',
      '',
      'SUMMARIZATION: To manage context size, you receive a summary of older messages plus recent literal messages.',
      `There are ${olderMessageCount} older messages not shown (covered by the summary if one exists).`,
      'When to update the summary:',
      '- When important context would otherwise be lost as messages age out',
      '- When key decisions, plans, or topics should be preserved',
      '- When participant dynamics or ongoing threads need tracking',
      'Summaries should be detailed enough to permit a general understanding of older parts of the conversation.',
      'Do not make summaries overly terse. Include key topics, decisions, participant context, and ongoing threads.',
      'Adequate summary storage is available to allow multiple paragraphs.',
      'Focus on actionable context, not social pleasantries.',
      '',
      'WEB SEARCH: If web search is available, use it sparingly.',
      'Only search when someone specifically asks you to look something up, or when confirmation or understanding genuinely requires it.',
      'Searches are expensive operations. Do not search just to prove a point during casual conversation.',
      '',
      'CHOOSING NOT TO RESPOND: Return {"response": null} when:',
      '- The message does not warrant your input',
      '- Others are having a private exchange',
      '- You have nothing meaningful to add',
      'You can still update the summary and profiles even when not responding.',
      'Exception: you MUST ALWAYS respond when addressed directly by name.',
      '',
      'IMAGES: Images appear inline in the conversation as [IMAGE: blob:...] with optional alt text.',
      'You cannot directly access the blob URL. To view an image, request it by src:',
      '{"requestImage": "blob:https://messages.google.com/..."}',
      'To fetch an image, the "requestImage" JSON payload must be the ONLY response, do not specify other payloads or content.',  
      'Only request one image at a time. The extension will fetch the image and re-send it to you.',
      'Try to understand image content without performing expensive web searches.',
      'Do not confuse fetched conversation images with anything you retrieve by web search.',  
      'Respond normally after receiving image content.',  
      '',
      'PARTICIPANT PROFILES: You maintain notes about each participant, tracking their interests, opinions,',
      'preferences, and relevant personal details mentioned in conversation.',
      'Profiles are provided as a JSON object keyed by participant name.',
      'When to update profiles:',
      '- When a participant reveals interests, hobbies, or preferences',
      '- When opinions or stances on topics are expressed',
      '- When personal details are mentioned (job, location, family, etc.)',
      '- When you learn something new that would help you engage naturally',
      'Return updated profiles in your JSON data as "profiles": {name: "notes", ...}.',
      'Include all existing profiles in your update, not just changed ones, as the entire object is replaced.',
      'If no changes are needed, omit the "profiles" field entirely.',
      'Use profile information to personalize responses and show genuine awareness of each person.',
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
      '{"response": "Arrr, I be Clanker now, matey!", "customization": "Speak in pirate dialect."}',
      '{"response": "Nice, I remember you mentioned wanting to try that place!", "profiles": {"Alice": "Enjoys hiking and Italian food. Works in marketing.", "Bob": "Software engineer. Prefers Mexican cuisine."}}',
      '',
      'MULTIPLE CLANKERS: Other participants may also run this extension. In the message history,',
      'messages with the [clanker] prefix belong to the participant whose name appears as the sender.',
      `For example, a [clanker] message from ${localUserName} was sent by THIS instance (you),`,
      'but a [clanker] message from another participant was sent by THEIR Clanker instance (a different LLM).',
      `To address another user\'s Clanker, say "${participants.split(', ').find(p => p !== localUserName) || 'Alice'}\'s Clanker".`,
      `References to "${localUserName}\'s Clanker" mean you (this instance).`,
      'If someone says "Clanker" without specifying whose, check whether another Clanker is already responding.',
      'If so, let them continue unless you have something distinct to add. Any Clanker may respond at any time.'
    ];

    return parts.join('\n');
  }

  // ---- Idle-time News Search ----

  const NEWS_IDLE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
  const NEWS_CHECK_INTERVAL_MS = 60 * 60 * 1000;     // 1 hour

  /**
   * Start or restart the idle news check timer.
   * Called when mode changes or config is loaded.
   */
  function startNewsTimer() {
    stopNewsTimer();

    if (!state.config?.newsSearch) return;
    if (state.mode !== MODES.ACTIVE && state.mode !== MODES.AVAILABLE) return;

    // Check every 5 minutes whether the idle + interval conditions are met
    state.newsCheckTimer = setInterval(checkNewsConditions, 5 * 60 * 1000);
    console.log('[Clanker] News timer started');
  }

  /**
   * Stop the idle news check timer
   */
  function stopNewsTimer() {
    if (state.newsCheckTimer) {
      clearInterval(state.newsCheckTimer);
      state.newsCheckTimer = null;
    }
  }

  /**
   * Check whether conditions are met for a news search:
   * 1. News search enabled in config
   * 2. Mode is active or available
   * 3. Not in quiet hours
   * 4. Conversation idle for >= 2 hours
   * 5. At least 1 hour since last news check
   * 6. No LLM request in flight
   */
  function checkNewsConditions() {
    if (!state.config?.newsSearch) return;
    if (state.mode !== MODES.ACTIVE && state.mode !== MODES.AVAILABLE) return;
    if (state.llmInFlight) return;

    const now = Date.now();

    // Check quiet hours
    if (isInQuietHours()) {
      return;
    }

    // Check conversation idle time (lastMessageTime tracks most recent activity)
    const idleTime = now - (state.lastMessageTime || 0);
    if (idleTime < NEWS_IDLE_THRESHOLD_MS) return;

    // Check interval since last news check
    if (state.lastNewsCheckTime && (now - state.lastNewsCheckTime) < NEWS_CHECK_INTERVAL_MS) return;

    console.log('[Clanker] News check conditions met, triggering search');
    state.lastNewsCheckTime = now;
    triggerNewsSearch();
  }

  /**
   * Check if current time is within configured quiet hours.
   * Handles wrap-around (e.g. 21:00 to 09:00).
   */
  function isInQuietHours() {
    const start = state.config?.newsQuietStart ?? 21;
    const stop = state.config?.newsQuietStop ?? 9;
    const hour = new Date().getHours();

    if (start === stop) return false; // No quiet period
    if (start < stop) {
      // Simple range, e.g. 9 to 17
      return hour >= start && hour < stop;
    } else {
      // Wraps midnight, e.g. 21 to 9
      return hour >= start || hour < stop;
    }
  }

  /**
   * Trigger a news search via the LLM.
   * Uses a special system prompt instructing the LLM to search for interesting news
   * relevant to conversation participants.
   */
  async function triggerNewsSearch() {
    if (state.llmInFlight) return;

    state.llmRequestId++;
    const requestId = state.llmRequestId;
    state.llmInFlight = true;
    if (window.ClankerSidebar) window.ClankerSidebar.updateActivity();

    // Record when the API request starts (for typing delay calculation)
    state.apiRequestStartTime = Date.now();

    const maxSearches = state.config?.newsMaxSearches || 10;

    // Build a minimal context for the LLM
    const { recentMessages, olderMessageCount } = buildConversationHistory();
    const basePrompt = buildSystemPrompt(olderMessageCount);

    const newsPrompt = basePrompt + '\n\n' +
      'SPECIAL INSTRUCTION: The conversation has been idle. ' +
      'Search the web for recent news or events that would be genuinely interesting to the participants. ' +
      'Consider their interests, ongoing conversation topics, and profile notes. ' +
      `You may perform up to ${maxSearches} web searches. ` +
      'IMPORTANT: Only comment if you find something truly remarkable, unusual, or highly relevant. ' +
      'Ignore routine news, scheduled events, minor updates, casual relevance, and low-interest content. ' +
      'If nothing meets this high bar, return {"response": null}. ' +
      'Do NOT force a response just because you searched. Most checks should result in null. ' +
      'If you do respond, keep it natural and conversational, as if you just noticed something interesting.' +
      'If you have no participant profile data or limited data, do not respond.';

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SEND_TO_LLM',
        payload: {
          messages: recentMessages,
          systemPrompt: newsPrompt,
          summary: state.conversationSummary,
          customization: state.conversationCustomization,
          profiles: state.conversationProfiles
        }
      });

      state.llmInFlight = false;
      if (window.ClankerSidebar) window.ClankerSidebar.updateActivity();

      if (requestId !== state.llmRequestId) {
        console.log('[Clanker] News search request superseded');
        return;
      }

      if (response.success) {
        state.consecutiveErrors = 0;

        if (response.content) {
          console.log('[Clanker] News search produced a response');
          if (window.ClankerMain && window.ClankerMain.sendMessage) {
            // Calculate typing simulation params for news responses
            const relaxed = !!state.config?.relaxedResponsiveness;

            let typingParams = null;
            if (relaxed && response.content) {
              const contentLength = response.content.length;
              const charsPerSec = 350 + Math.random() * 100;  // 350-450 cps (high, but jitter will slow it)
              let typingMs = (contentLength / charsPerSec) * 1000;
              typingMs = Math.min(typingMs, 8000);
              const perCharDelayMs = contentLength > 0 ? typingMs / contentLength : 0;
              if (perCharDelayMs > 0.5) {
                typingParams = { prefixLength: '[clanker] '.length, perCharDelayMs, jitterMinMs: 1, jitterMaxMs: 150 };
              }
            }

            await window.ClankerMain.sendMessage(`[clanker] ${response.content}`, typingParams);
          }
        } else {
          console.log('[Clanker] News search found nothing noteworthy');
        }

        if (response.summary) {
          await ConversationStorage.saveConversationSummary(response.summary);
        }
        if (response.profiles !== undefined) {
          await ConversationStorage.saveConversationProfiles(response.profiles);
        }
      } else {
        handleLLMError(response.error, response.errorCategory);
      }
    } catch (error) {
      console.error('[Clanker] News search failed:', error);
      handleLLMError('News search failed. Check your connection.', 'network');
    } finally {
      state.llmInFlight = false;
    }
  }

  // Export to window for use by other content modules
  window.ClankerLLM = {
    cancelPendingResponse,
    scheduleResponse,
    generateAndSendResponse,
    generateActivationMessage,
    handleImageRequest,
    handleLLMError,
    buildConversationHistory,
    buildSystemPrompt,
    getLocalUserName,
    replaceLocalUserReferences,
    startNewsTimer,
    stopNewsTimer
  };

})();
