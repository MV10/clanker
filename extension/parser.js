/**
 * Clanker Parser Module
 * Isolates all Google Messages DOM parsing logic for easier maintenance
 * when Google updates their page structure.
 *
 * This file should be the ONLY file that needs modification when
 * Google Messages changes their DOM structure.
 */

'use strict';

/**
 * Data structure for a message reaction
 * @typedef {Object} Reaction
 * @property {string[]} reactors - Names of people who reacted (may include phone numbers)
 * @property {string} type - Reaction type (love, laugh, etc.)
 */

/**
 * Data structure for a parsed message
 * @typedef {Object} ParsedMessage
 * @property {string} id - Unique message ID from DOM or generated fallback
 * @property {string} sender - Name of the message sender ("You" for local user, or phone number)
 * @property {string} content - Message text content (or "[IMAGE]" for image-only messages)
 * @property {string} type - Message type: "text", "image", or "text+image"
 * @property {string|null} imageSrc - Blob URL for image messages, null otherwise
 * @property {boolean} isLocalUser - True if sent by the local user
 * @property {boolean} isOutgoing - True if message direction is "Sent"
 * @property {boolean} isClanker - True if this is a Clanker-generated message
 * @property {string} timestamp - Raw timestamp string from aria-label
 * @property {Reaction[]} reactions - Array of reactions on this message
 * @property {Element} element - Reference to the DOM element
 */

/**
 * Data structure for conversation context
 * @typedef {Object} ConversationContext
 * @property {string} conversationId - Unique identifier for the conversation
 * @property {Set<string>} participants - Set of participant names
 * @property {ParsedMessage[]} messages - Array of parsed messages (includes images in sequence)
 * @property {number} messageCount - Total number of messages parsed
 */

/**
 * Operating modes for the extension
 * @typedef {'uninitialized'|'deactivated'|'active'|'available'} OperatingMode
 */

/**
 * DOM Selectors for Google Messages
 * Based on page structure observations as of JAN-2026
 * UPDATE THESE when Google changes their DOM structure
 */
const ClankerSelectors = {
  // Conversation structure
  CONVERSATION_CONTAINER: '[data-e2e-conversation-container]',
  CONVERSATION_THREAD: 'mws-messages-list',

  // Message elements - wrapper contains the message ID
  MESSAGE_WRAPPER: '[data-e2e-message-wrapper]',
  MESSAGE_WRAPPER_CORE: '[data-e2e-message-wrapper-core]',
  MESSAGE_ID_ATTR: 'data-e2e-message-id',

  // Message parts (children of wrapper)
  MESSAGE_TEXT_PART: 'mws-text-message-part',
  MESSAGE_IMAGE_PART: 'mws-image-message-part',

  // Input controls
  INPUT_FIELD: '[data-e2e-message-input]',
  INPUT_BOX: '[data-e2e-message-input-box]',
  SEND_BUTTON: '[data-e2e-send-text-button]',

  // Sidebar (to ignore)
  SIDEBAR_ITEM: 'mws-conversation-list-item',

  // Tombstone messages (deleted/unsupported - to skip)
  MESSAGE_TOMBSTONE: '[data-e2e-message-tombstone]',
};

/**
 * Regex patterns for parsing message content
 * UPDATE THESE when Google changes their aria-label format
 *
 * Text message aria-label format:
 *   "NAME said: MESSAGE. Sent/Received on DATE at TIME. STATUS."
 *   Example: "You said: Hello. Sent on January 1, 2026 at 12:00 PM. SMS."
 *
 * Image message aria-label format:
 *   "NAME sent an image. Sent/Received on DATE at TIME. STATUS."
 *   Example: "You sent an image. Sent on January 1, 2026 at 4:23 PM. Delivered."
 *
 * Reaction aria-label format:
 *   "NAME said: Laughed at "MESSAGE". Received on DATE at TIME."
 *   "NAME said: Laughed at an image. Received on DATE at TIME."
 */
const ClankerPatterns = {
  // Text message: "NAME said: MESSAGE. Sent/Received on DATE at TIME. STATUS."
  // Captures: (1) sender, (2) content, (3) direction, (4) timestamp
  // Note: Content uses [\s\S]*? to match across potential newlines, non-greedy
  // The timestamp is everything after "on " until the next period
  TEXT_MESSAGE: /^(.+?)\s+said:\s*([\s\S]*?)\.\s*(Sent|Received)\s+on\s+([^.]+)\./i,

  // Image message: "NAME sent an image. Sent/Received on DATE at TIME. STATUS."
  // Captures: (1) sender, (2) direction, (3) timestamp
  IMAGE_MESSAGE: /^(.+?)\s+sent an image\.\s*(Sent|Received)\s+on\s+([^.]+)\./i,

  // Matches individual reactions: "NAME reacted with TYPE." or "NAME and NAME reacted with TYPE."
  // Used to parse the reactions suffix captured by MESSAGE_ARIA_LABEL
  REACTION: /([^.]+?)\s+reacted\s+with\s+(\w+)\./gi,

  // Pattern to detect when Clanker is mentioned (for Available mode)
  // Matches both "clanker" and "clank"
  CLANKER_MENTION: /clank(er)?/i,
};

/**
 * Parser class for Google Messages DOM
 */
const ClankerParser = {
  /**
   * Verify that the expected page structure exists
   * @returns {{valid: boolean, hasActiveConversation: boolean, details: Object}}
   */
  verifyPageStructure() {
    const details = {
      hasSidebar: document.querySelector(ClankerSelectors.SIDEBAR_ITEM) !== null,
      hasConversationContainer: document.querySelector(ClankerSelectors.CONVERSATION_CONTAINER) !== null,
      hasConversationThread: document.querySelector(ClankerSelectors.CONVERSATION_THREAD) !== null,
      hasMessageWrapper: document.querySelector(ClankerSelectors.MESSAGE_WRAPPER) !== null,
      hasInputField: document.querySelector(ClankerSelectors.INPUT_FIELD) !== null ||
                     document.querySelector(ClankerSelectors.INPUT_BOX) !== null,
    };

    // Page is valid if we can find Google Messages elements (sidebar confirms we're on the right page)
    const hasConversation = details.hasConversationContainer ||
                            details.hasConversationThread ||
                            details.hasMessageWrapper;

    // Valid if we have a conversation OR we have the sidebar (no conversation selected yet)
    const valid = hasConversation || details.hasSidebar;

    // Track whether a conversation is active
    const hasActiveConversation = hasConversation;

    return { valid, hasActiveConversation, details };
  },

  /**
   * Detect the current conversation ID
   * @returns {string}
   */
  detectConversationId() {
    // Try to get conversation ID from URL
    const urlMatch = window.location.href.match(/\/conversations\/([^/?#]+)/);
    if (urlMatch) {
      return urlMatch[1];
    }

    // Fallback: hash sorted participant names for immutable identifier
    const participants = this.extractParticipantNames();
    if (participants.length === 0) {
      return 'unknown';
    }

    const sorted = participants.sort().join('|');
    return `participants-${this.hashString(sorted)}`;
  },

  /**
   * Generate a hash from a string (for stable identifiers)
   * @param {string} str
   * @returns {string}
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Convert to unsigned and then to base36 for compact representation
    return (hash >>> 0).toString(36);
  },

  /**
   * Extract participant names from visible messages
   * @returns {string[]}
   */
  extractParticipantNames() {
    const participants = new Set();

    // Check text message parts
    const textParts = document.querySelectorAll(ClankerSelectors.MESSAGE_TEXT_PART);
    for (const el of textParts) {
      const ariaLabel = el.getAttribute('aria-label');
      if (!ariaLabel) continue;

      const match = ariaLabel.match(/^(.+?)\s+said:/i);
      if (match && match[1] !== 'You') {
        participants.add(match[1].trim());
      }
    }

    // Check image message parts
    const imageParts = document.querySelectorAll(ClankerSelectors.MESSAGE_IMAGE_PART);
    for (const el of imageParts) {
      const ariaLabel = el.getAttribute('aria-label');
      if (!ariaLabel) continue;

      const match = ariaLabel.match(/^(.+?)\s+sent an image/i);
      if (match && match[1] !== 'You') {
        participants.add(match[1].trim());
      }
    }

    return Array.from(participants);
  },

  /**
   * Parse all visible messages in the conversation
   * Messages are returned in DOM order (which should be chronological)
   * @returns {ConversationContext}
   */
  parseConversation() {
    const conversationId = this.detectConversationId();
    const participants = new Set();
    const messages = [];
    const seenIds = new Set();

    // Query all message wrapper cores - these contain the message ID
    const wrappers = document.querySelectorAll(ClankerSelectors.MESSAGE_WRAPPER_CORE);

    for (const wrapper of wrappers) {
      // Skip tombstones
      if (this.isTombstone(wrapper)) {
        continue;
      }

      const messageId = wrapper.getAttribute(ClankerSelectors.MESSAGE_ID_ATTR);
      if (!messageId || seenIds.has(messageId)) {
        continue;
      }
      seenIds.add(messageId);

      // Find all parts within this message wrapper
      const textPart = wrapper.querySelector(ClankerSelectors.MESSAGE_TEXT_PART);
      const imagePart = wrapper.querySelector(ClankerSelectors.MESSAGE_IMAGE_PART);

      // Parse based on what parts exist
      let parsed = null;

      if (textPart && imagePart) {
        // Combo message: text + image
        parsed = this.parseTextImageMessage(messageId, textPart, imagePart);
      } else if (textPart) {
        // Text-only message
        parsed = this.parseTextMessage(messageId, textPart);
      } else if (imagePart) {
        // Image-only message
        parsed = this.parseImageMessage(messageId, imagePart);
      }

      if (parsed) {
        messages.push(parsed);
        participants.add(parsed.sender);
      }
    }

    return {
      conversationId,
      participants,
      messages,
      messageCount: messages.length,
    };
  },

  /**
   * Parse a text-only message
   * @param {string} messageId
   * @param {Element} textPart
   * @returns {ParsedMessage|null}
   */
  parseTextMessage(messageId, textPart) {
    const ariaLabel = textPart.getAttribute('aria-label');
    if (!ariaLabel) return null;

    const match = ariaLabel.match(ClankerPatterns.TEXT_MESSAGE);
    if (!match) return null;

    const sender = match[1].trim();
    const content = match[2].trim();
    const direction = match[3].toLowerCase();
    const timestamp = match[4].trim();

    const isClanker = sender === 'You' && content.startsWith('[clanker]');
    const isLocalUser = sender === 'You';
    const isOutgoing = direction === 'sent';

    return {
      id: messageId,
      sender,
      content,
      type: 'text',
      imageSrc: null,
      isLocalUser,
      isOutgoing,
      isClanker,
      timestamp,
      reactions: [], // TODO: parse reactions if needed
      element: textPart,
    };
  },

  /**
   * Parse an image-only message
   * @param {string} messageId
   * @param {Element} imagePart
   * @returns {ParsedMessage|null}
   */
  parseImageMessage(messageId, imagePart) {
    const ariaLabel = imagePart.getAttribute('aria-label');
    if (!ariaLabel) return null;

    const match = ariaLabel.match(ClankerPatterns.IMAGE_MESSAGE);
    if (!match) return null;

    const sender = match[1].trim();
    const direction = match[2].toLowerCase();
    const timestamp = match[3].trim();

    const isLocalUser = sender === 'You';
    const isOutgoing = direction === 'sent';

    // Get the image blob URL
    const img = imagePart.querySelector('img');
    const imageSrc = img ? img.src : null;

    return {
      id: messageId,
      sender,
      content: '[IMAGE]',
      type: 'image',
      imageSrc,
      isLocalUser,
      isOutgoing,
      isClanker: false, // Images can't be Clanker messages
      timestamp,
      reactions: [],
      element: imagePart,
    };
  },

  /**
   * Parse a combo text+image message
   * @param {string} messageId
   * @param {Element} textPart
   * @param {Element} imagePart
   * @returns {ParsedMessage|null}
   */
  parseTextImageMessage(messageId, textPart, imagePart) {
    // Use text part for main content
    const textAriaLabel = textPart.getAttribute('aria-label');
    if (!textAriaLabel) return null;

    const match = textAriaLabel.match(ClankerPatterns.TEXT_MESSAGE);
    if (!match) return null;

    const sender = match[1].trim();
    const content = match[2].trim();
    const direction = match[3].toLowerCase();
    const timestamp = match[4].trim();

    const isClanker = sender === 'You' && content.startsWith('[clanker]');
    const isLocalUser = sender === 'You';
    const isOutgoing = direction === 'sent';

    // Get the image blob URL
    const img = imagePart.querySelector('img');
    const imageSrc = img ? img.src : null;

    return {
      id: messageId,
      sender,
      content,
      type: 'text+image',
      imageSrc,
      isLocalUser,
      isOutgoing,
      isClanker,
      timestamp,
      reactions: [],
      element: textPart,
    };
  },

  /**
   * Check if an element is a tombstone (deleted/unsupported message)
   * @param {Element} element
   * @returns {boolean}
   */
  isTombstone(element) {
    // Check the element itself
    if (element.hasAttribute && element.hasAttribute('data-e2e-message-tombstone')) {
      return true;
    }
    // Check parent wrapper
    if (element.closest && element.closest(ClankerSelectors.MESSAGE_TOMBSTONE)) {
      return true;
    }
    return false;
  },

  /**
   * Get the stable message ID from the DOM element
   * @param {Element} element
   * @returns {string}
   */
  getMessageId(element) {
    // Check the element itself
    let id = element.getAttribute(ClankerSelectors.MESSAGE_ID_ATTR);
    if (id) return id;

    // Walk up to find the message wrapper with the ID
    let current = element.parentElement;
    while (current && current !== document.body) {
      id = current.getAttribute(ClankerSelectors.MESSAGE_ID_ATTR);
      if (id) return id;
      current = current.parentElement;
    }

    // Fallback: generate hash-based ID
    return this.generateFallbackId(element);
  },

  /**
   * Generate a fallback ID based on content hash
   * @param {Element} element
   * @returns {string}
   */
  generateFallbackId(element) {
    const ariaLabel = element.getAttribute('aria-label') || '';
    return `fallback-${this.hashString(ariaLabel)}`;
  },

  /**
   * Check if an element is within the sidebar (should be ignored)
   * @param {Element} element
   * @returns {boolean}
   */
  isInSidebar(element) {
    if (element.matches && element.matches(ClankerSelectors.SIDEBAR_ITEM)) {
      return true;
    }
    if (element.closest && element.closest(ClankerSelectors.SIDEBAR_ITEM)) {
      return true;
    }
    return false;
  },

  /**
   * Find message part elements within a DOM node (for mutation observer)
   * @param {Element} node
   * @returns {Element[]}
   */
  findMessageElements(node) {
    const elements = [];

    // Check if node itself is a message part
    if (node.matches) {
      if (node.matches(ClankerSelectors.MESSAGE_TEXT_PART)) {
        elements.push(node);
      }
      if (node.matches(ClankerSelectors.MESSAGE_IMAGE_PART)) {
        elements.push(node);
      }
    }

    // Find message parts within the node
    if (node.querySelectorAll) {
      const textParts = node.querySelectorAll(ClankerSelectors.MESSAGE_TEXT_PART);
      const imageParts = node.querySelectorAll(ClankerSelectors.MESSAGE_IMAGE_PART);
      elements.push(...textParts, ...imageParts);
    }

    return elements;
  },

  /**
   * Parse a single message element (for mutation observer - new message detection)
   * @param {Element} element - Either a text or image message part
   * @returns {ParsedMessage|null}
   */
  parseMessageElement(element) {
    // Skip tombstone messages
    if (this.isTombstone(element)) {
      return null;
    }

    const messageId = this.getMessageId(element);
    const ariaLabel = element.getAttribute('aria-label');
    if (!ariaLabel) return null;

    // Try text message pattern
    let match = ariaLabel.match(ClankerPatterns.TEXT_MESSAGE);
    if (match) {
      const sender = match[1].trim();
      const content = match[2].trim();
      const direction = match[3].toLowerCase();
      const timestamp = match[4].trim();

      return {
        id: messageId,
        sender,
        content,
        type: 'text',
        imageSrc: null,
        isLocalUser: sender === 'You',
        isOutgoing: direction === 'sent',
        isClanker: sender === 'You' && content.startsWith('[clanker]'),
        timestamp,
        reactions: [],
        element,
      };
    }

    // Try image message pattern
    match = ariaLabel.match(ClankerPatterns.IMAGE_MESSAGE);
    if (match) {
      const sender = match[1].trim();
      const direction = match[2].toLowerCase();
      const timestamp = match[3].trim();

      const img = element.querySelector('img');
      const imageSrc = img ? img.src : null;

      return {
        id: messageId,
        sender,
        content: '[IMAGE]',
        type: 'image',
        imageSrc,
        isLocalUser: sender === 'You',
        isOutgoing: direction === 'sent',
        isClanker: false,
        timestamp,
        reactions: [],
        element,
      };
    }

    return null;
  },

  /**
   * Check if content mentions Clanker (for Available mode)
   * @param {string} content
   * @returns {boolean}
   */
  mentionsClanker(content) {
    return ClankerPatterns.CLANKER_MENTION.test(content);
  },

  /**
   * Get input field element
   * @returns {Element|null}
   */
  getInputField() {
    return document.querySelector(ClankerSelectors.INPUT_FIELD) ||
           document.querySelector(ClankerSelectors.INPUT_BOX);
  },

  /**
   * Get send button element
   * @returns {Element|null}
   */
  getSendButton() {
    return document.querySelector(ClankerSelectors.SEND_BUTTON);
  },

  /**
   * Check if page content is loaded (for initialization)
   * @returns {boolean}
   */
  isPageReady() {
    return !!(
      document.querySelector(ClankerSelectors.CONVERSATION_CONTAINER) ||
      document.querySelector(ClankerSelectors.CONVERSATION_THREAD) ||
      document.querySelector(ClankerSelectors.MESSAGE_WRAPPER)
    );
  },
};

// Export for use by content.js
// In Chrome extension content scripts, we use window to share between scripts
window.ClankerParser = ClankerParser;
window.ClankerSelectors = ClankerSelectors;
window.ClankerPatterns = ClankerPatterns;
