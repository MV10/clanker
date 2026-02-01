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

  // Parser and Storage modules are loaded before this script via manifest.json
  const Parser = window.ClankerParser;
  const Selectors = window.ClankerSelectors;
  const Storage = window.ClankerStorage;

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
    conversationSummary: null, // LLM-generated summary of older messages
    conversationCustomization: null, // LLM-managed persona/style customization
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
   * Number of recent messages to send literally (not summarized)
   */
  const RECENT_MESSAGE_COUNT = 10;

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
   * Cached image data (most recent optimized image)
   */
  let cachedImage = {
    src: null,        // Original blob URL
    messageId: null,  // Message containing the image
    dataUrl: null,    // Optimized base64 data URL
    width: null,
    height: null
  };

  /**
   * Calculate optimal dimensions for LLM image processing
   * Long edge should be a multiple of 448, up to 1344 max
   */
  function calculateOptimalDimensions(width, height) {
    const { TILE_SIZE, MAX_DIMENSION } = IMAGE_CONFIG;
    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);

    // Calculate target long edge (multiple of 448, max 1344)
    let targetLong = Math.min(
      Math.ceil(longEdge / TILE_SIZE) * TILE_SIZE,
      MAX_DIMENSION
    );

    // If original is smaller than one tile, use one tile
    if (longEdge < TILE_SIZE) {
      targetLong = TILE_SIZE;
    }

    // Calculate scale factor and short edge
    const scale = targetLong / longEdge;
    const targetShort = Math.round(shortEdge * scale);

    // Return in correct orientation
    if (width >= height) {
      return { width: targetLong, height: targetShort };
    } else {
      return { width: targetShort, height: targetLong };
    }
  }

  /**
   * Fetch and optimize an image from a blob URL
   * @param {string} blobUrl - The blob URL to fetch
   * @returns {Promise<{dataUrl: string, width: number, height: number}>}
   */
  async function fetchAndOptimizeImage(blobUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = () => {
        try {
          const { width, height } = calculateOptimalDimensions(img.naturalWidth, img.naturalHeight);

          // Create canvas and draw resized image
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          // Convert to JPEG with specified quality
          const dataUrl = canvas.toDataURL('image/jpeg', IMAGE_CONFIG.JPEG_QUALITY);

          resolve({ dataUrl, width, height });
        } catch (error) {
          reject(new Error(`Failed to process image: ${error.message}`));
        }
      };

      img.onerror = () => {
        reject(new Error('Failed to load image from blob URL'));
      };

      img.src = blobUrl;
    });
  }

  /**
   * Get or fetch the cached optimized image
   * @param {string} src - Image blob URL
   * @param {string} messageId - Message ID containing the image
   * @returns {Promise<{dataUrl: string, width: number, height: number}|null>}
   */
  async function getOptimizedImage(src, messageId) {
    // Return cached if same image
    if (cachedImage.src === src && cachedImage.dataUrl) {
      console.log('[Clanker] Using cached image');
      return {
        dataUrl: cachedImage.dataUrl,
        width: cachedImage.width,
        height: cachedImage.height
      };
    }

    // Try to load from IndexedDB
    const cacheKey = `image_cache_${state.currentConversationId}`;
    try {
      const stored = await Storage.get(cacheKey);
      if (stored[cacheKey] && stored[cacheKey].src === src) {
        console.log('[Clanker] Loaded image from IndexedDB cache');
        cachedImage = stored[cacheKey];
        return {
          dataUrl: cachedImage.dataUrl,
          width: cachedImage.width,
          height: cachedImage.height
        };
      }
    } catch (e) {
      console.warn('[Clanker] Failed to load cached image:', e);
    }

    // Fetch and optimize the image
    try {
      console.log('[Clanker] Fetching and optimizing image...');
      const optimized = await fetchAndOptimizeImage(src);

      // Update cache
      cachedImage = {
        src,
        messageId,
        dataUrl: optimized.dataUrl,
        width: optimized.width,
        height: optimized.height
      };

      // Store in IndexedDB
      await Storage.set({ [cacheKey]: cachedImage });
      console.log('[Clanker] Cached optimized image');

      return optimized;
    } catch (error) {
      console.error('[Clanker] Failed to optimize image:', error);
      return null;
    }
  }

  /**
   * Get all images indexed by message ID for inline placement
   */
  function getImagesByMessageId() {
    const images = Parser.findAllImages();
    const imageMap = new Map();
    for (const img of images) {
      if (!imageMap.has(img.messageId)) {
        imageMap.set(img.messageId, []);
      }
      imageMap.get(img.messageId).push(img);
    }
    return imageMap;
  }

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
      state.conversationSummary = null;
      state.conversationCustomization = null;
      state.processedMessageIds.clear();
      cancelPendingResponse();

      // Reset mode to deactivated for new conversations
      state.mode = MODES.DEACTIVATED;
      await chrome.runtime.sendMessage({ type: 'SET_MODE', mode: MODES.DEACTIVATED });
    }

    state.currentConversationId = newConversationId;

    // Load any existing summary and customization for this conversation
    await loadConversationSummary();
    await loadConversationCustomization();
  }

  /**
   * Load conversation summary from storage
   */
  async function loadConversationSummary() {
    if (!state.currentConversationId) return;

    try {
      const key = `summary_${state.currentConversationId}`;
      const result = await Storage.get(key);
      state.conversationSummary = result[key] || null;

      if (state.conversationSummary) {
        console.log('[Clanker] Loaded conversation summary');
      }
    } catch (error) {
      console.warn('[Clanker] Failed to load conversation summary:', error);
    }
  }

  /**
   * Save conversation summary to storage
   */
  async function saveConversationSummary(summary) {
    if (!state.currentConversationId || !summary) return;

    try {
      const key = `summary_${state.currentConversationId}`;
      await Storage.set({ [key]: summary });
      state.conversationSummary = summary;
      console.log('[Clanker] Saved conversation summary');
    } catch (error) {
      console.warn('[Clanker] Failed to save conversation summary:', error);
    }
  }

  /**
   * Load conversation customization from storage
   */
  async function loadConversationCustomization() {
    if (!state.currentConversationId) return;

    try {
      const key = `customization_${state.currentConversationId}`;
      const result = await Storage.get(key);
      state.conversationCustomization = result[key] || null;

      if (state.conversationCustomization) {
        console.log('[Clanker] Loaded conversation customization');
      }
    } catch (error) {
      console.warn('[Clanker] Failed to load conversation customization:', error);
    }
  }

  /**
   * Save conversation customization to storage
   */
  async function saveConversationCustomization(customization) {
    if (!state.currentConversationId) return;

    try {
      const key = `customization_${state.currentConversationId}`;
      if (customization) {
        await Storage.set({ [key]: customization });
        state.conversationCustomization = customization;
        console.log('[Clanker] Saved conversation customization');
      } else {
        // Allow clearing customization
        await Storage.remove(key);
        state.conversationCustomization = null;
        console.log('[Clanker] Cleared conversation customization');
      }
    } catch (error) {
      console.warn('[Clanker] Failed to save conversation customization:', error);
    }
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
  async function generateAndSendResponse() {
    const { recentMessages, olderMessageCount } = buildConversationHistory();
    const systemPrompt = buildSystemPrompt(olderMessageCount);

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

      // Handle image request from LLM (src URI)
      if (response.success && response.requestImage) {
        response = await handleImageRequest(response.requestImage, recentMessages, systemPrompt);
      }

      if (response.success) {
        // LLM can return null response if it decides not to reply
        if (response.content) {
          sendMessage(`[clanker] ${response.content}`);
        } else {
          console.log('[Clanker] LLM chose not to respond');
        }

        // Save updated summary if provided (even if response was null)
        if (response.summary) {
          await saveConversationSummary(response.summary);
        }

        // Save updated customization if provided (can be null to clear)
        if (response.customization !== undefined) {
          await saveConversationCustomization(response.customization);
        }
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
    const optimized = await getOptimizedImage(imageSrc, null);
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
    // Re-parse to get current state
    const context = Parser.parseConversation();
    const allMessages = context.messages;
    const imagesByMessage = getImagesByMessageId();

    // Build unified entries: text messages with their associated images
    const allEntries = [];
    const seenImageSrcs = new Set();

    for (const msg of allMessages) {
      // Add text message
      allEntries.push({
        type: 'text',
        id: msg.id,
        sender: msg.sender,
        content: msg.content,
        isClanker: msg.isClanker
      });

      // Add any images associated with this message
      const msgImages = imagesByMessage.get(msg.id) || [];
      for (const img of msgImages) {
        if (!seenImageSrcs.has(img.src)) {
          seenImageSrcs.add(img.src);
          allEntries.push({
            type: 'image',
            id: msg.id,
            sender: msg.sender,
            src: img.src,
            alt: img.alt
          });
        }
      }
    }

    // Handle orphan images (images without a matching text message)
    for (const [messageId, images] of imagesByMessage) {
      for (const img of images) {
        if (!seenImageSrcs.has(img.src)) {
          seenImageSrcs.add(img.src);
          allEntries.push({
            type: 'image',
            id: messageId,
            sender: 'Unknown',
            src: img.src,
            alt: img.alt
          });
        }
      }
    }

    // Split into older (to be summarized) and recent (sent literally)
    const recentStart = Math.max(0, allEntries.length - RECENT_MESSAGE_COUNT);
    const olderMessageCount = recentStart;
    const recentEntries = allEntries.slice(recentStart);

    const recentMessages = [];
    for (const entry of recentEntries) {
      if (entry.type === 'text') {
        const role = entry.isClanker ? 'assistant' : 'user';
        let content = entry.content;

        if (entry.isClanker) {
          content = content.replace(/^\[clanker\]\s*/i, '');
        } else {
          content = `${entry.sender}: ${content}`;
        }

        recentMessages.push({ role, content });
      } else if (entry.type === 'image') {
        // Images appear as user messages with special format
        const content = `${entry.sender}: [IMAGE: ${entry.src}]${entry.alt ? ` "${entry.alt}"` : ''}`;
        recentMessages.push({ role: 'user', content });
      }
    }

    return { recentMessages, olderMessageCount };
  }

  /**
   * Build system prompt for LLM
   */
  function buildSystemPrompt(olderMessageCount) {
    const participants = state.conversation
      ? Array.from(state.conversation.participants).join(', ')
      : 'unknown';

    const parts = [
      'You are Clanker, an AI assistant participating in an SMS group chat via browser extension.',
      'Keep your responses brief and casual, matching the SMS chat style.',
      'Do not dominate the conversation. Only respond when appropriate.',
      `Current participants: ${participants}.`,
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
