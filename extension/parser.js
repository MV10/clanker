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
 * @property {string} content - Message text content
 * @property {boolean} isLocalUser - True if sent by the local user
 * @property {boolean} isOutgoing - True if message direction is "Sent"
 * @property {boolean} isClanker - True if this is a Clanker-generated message
 * @property {string} timestamp - Raw timestamp string from aria-label
 * @property {Reaction[]} reactions - Array of reactions on this message
 * @property {Element} element - Reference to the DOM element
 */

/**
 * Data structure for an image attachment
 * @typedef {Object} ImageAttachment
 * @property {string} src - Image source URL (blob URL)
 * @property {string} alt - Alt text or description
 * @property {string} messageId - ID of the message containing this image
 */

/**
 * Data structure for conversation context
 * @typedef {Object} ConversationContext
 * @property {string} conversationId - Unique identifier for the conversation
 * @property {Set<string>} participants - Set of participant names
 * @property {ParsedMessage[]} messages - Array of parsed messages
 * @property {ImageAttachment[]} images - Array of image attachments
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

  // Message elements
  MESSAGE_WRAPPER: '[data-e2e-message-wrapper]',
  MESSAGE_TEXT: 'mws-text-message-part[data-e2e-text-message-content]',
  MESSAGE_IMAGE: 'mws-image-message-part',
  MESSAGE_ID_ATTR: 'data-e2e-message-id',

  // Text content (aria-label is on this element)
  MESSAGE_CONTENT: 'mws-text-message-part',

  // Image sources
  IMAGE_BLOB: 'img[src^="blob:https://messages.google.com/"]',

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
 */
const ClankerPatterns = {
  // Matches: "NAME said: MESSAGE. Sent/Received on DATE at TIME. [Read.] [REACTIONS]"
  // Captures: (1) sender, (2) content, (3) direction, (4) timestamp, (5) optional reactions suffix
  // Note: Content may include periods (sentences, emojis, etc.)
  MESSAGE_ARIA_LABEL: /^(.+?)\s+said:\s*(.*?)\.\s*(Sent|Received)\s+on\s+([^.]+(?:\s+at\s+[^.]+)?)\.((?:\s+Read\.)?(?:\s+.+\s+reacted\s+with\s+.+)*)$/i,

  // Fallback: captures up to Sent/Received, handles messages without reactions
  MESSAGE_ARIA_LABEL_FALLBACK: /^(.+?)\s+said:\s*(.*?)\.\s*(Sent|Received)\s+on\s+/i,

  // Matches individual reactions: "NAME reacted with TYPE." or "NAME and NAME reacted with TYPE."
  // Used to parse the reactions suffix captured by MESSAGE_ARIA_LABEL
  REACTION: /([^.]+?)\s+reacted\s+with\s+(\w+)\./gi,

  // Pattern to detect when Clanker is mentioned (for Available mode)
  CLANKER_MENTION: /clanker/i,
};

/**
 * Parser class for Google Messages DOM
 */
const ClankerParser = {
  /**
   * Verify that the expected page structure exists
   * @returns {{valid: boolean, details: Object}}
   */
  verifyPageStructure() {
    const details = {
      hasConversationContainer: document.querySelector(ClankerSelectors.CONVERSATION_CONTAINER) !== null,
      hasConversationThread: document.querySelector(ClankerSelectors.CONVERSATION_THREAD) !== null,
      hasMessageWrapper: document.querySelector(ClankerSelectors.MESSAGE_WRAPPER) !== null,
      hasMessageContent: document.querySelector(ClankerSelectors.MESSAGE_CONTENT) !== null,
      hasInputField: document.querySelector(ClankerSelectors.INPUT_FIELD) !== null ||
                     document.querySelector(ClankerSelectors.INPUT_BOX) !== null,
    };

    const valid = details.hasConversationContainer ||
                  details.hasConversationThread ||
                  details.hasMessageWrapper ||
                  details.hasMessageContent;

    return { valid, details };
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
    const messages = document.querySelectorAll(ClankerSelectors.MESSAGE_CONTENT);

    for (const el of messages) {
      const ariaLabel = el.getAttribute('aria-label');
      if (!ariaLabel) continue;

      const match = ariaLabel.match(/^(.+?)\s+said:/i);
      if (match && match[1] !== 'You') {
        participants.add(match[1].trim());
      }
    }

    return Array.from(participants);
  },

  /**
   * Parse all visible messages in the conversation
   * @returns {ConversationContext}
   */
  parseConversation() {
    const conversationId = this.detectConversationId();
    const participants = new Set();
    const messages = [];
    const messageElements = document.querySelectorAll(ClankerSelectors.MESSAGE_CONTENT);

    for (const el of messageElements) {
      const parsed = this.parseMessageElement(el);
      if (parsed) {
        messages.push(parsed);
        participants.add(parsed.sender);
      }
    }

    const images = this.findAllImages();

    return {
      conversationId,
      participants,
      messages,
      images,
      messageCount: messages.length,
    };
  },

  /**
   * Parse a single message element
   * @param {Element} element
   * @returns {ParsedMessage|null}
   */
  parseMessageElement(element) {
    // Skip tombstone messages (deleted/unsupported content)
    if (this.isTombstone(element)) {
      return null;
    }

    const ariaLabel = element.getAttribute('aria-label');
    if (!ariaLabel) return null;

    // Try primary pattern first
    let match = ariaLabel.match(ClankerPatterns.MESSAGE_ARIA_LABEL);
    let timestamp = '';
    let reactionsSuffix = '';

    if (match) {
      timestamp = match[4];
      reactionsSuffix = match[5] || '';
    } else {
      // Try fallback pattern
      match = ariaLabel.match(ClankerPatterns.MESSAGE_ARIA_LABEL_FALLBACK);
      if (!match) return null;
    }

    const sender = match[1].trim();
    const content = match[2].trim();
    const direction = match[3].toLowerCase();

    const isClanker = sender === 'You' && content.startsWith('[clanker]');
    const isLocalUser = sender === 'You';
    const isOutgoing = direction === 'sent';

    const id = this.getMessageId(element);
    const reactions = this.parseReactions(reactionsSuffix);

    return {
      id,
      sender,
      content,
      isLocalUser,
      isOutgoing,
      isClanker,
      timestamp,
      reactions,
      element,
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
   * Parse reactions from the aria-label suffix
   * @param {string} reactionsSuffix - Text after timestamp containing reaction info
   * @returns {Reaction[]}
   */
  parseReactions(reactionsSuffix) {
    const reactions = [];
    if (!reactionsSuffix) return reactions;

    // Reset regex state for global matching
    ClankerPatterns.REACTION.lastIndex = 0;

    let reactionMatch;
    while ((reactionMatch = ClankerPatterns.REACTION.exec(reactionsSuffix)) !== null) {
      const reactorsText = reactionMatch[1].trim();
      const type = reactionMatch[2].toLowerCase();

      // Parse reactor names (handles "You and (228) 324-0037" format)
      const reactors = this.parseReactorNames(reactorsText);

      reactions.push({ reactors, type });
    }

    return reactions;
  },

  /**
   * Parse reactor names from text like "You and (228) 324-0037" or "Sherry"
   * @param {string} text
   * @returns {string[]}
   */
  parseReactorNames(text) {
    // Split by " and " but preserve phone numbers like "(228) 324-0037"
    const parts = text.split(/\s+and\s+/i);
    return parts.map(p => p.trim()).filter(p => p.length > 0);
  },

  /**
   * Get the stable message ID from the DOM
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
   * Find all image attachments in the conversation
   * @returns {ImageAttachment[]}
   */
  findAllImages() {
    const attachments = [];
    const seen = new Set();

    // Find image message parts
    const imageParts = document.querySelectorAll(ClankerSelectors.MESSAGE_IMAGE);
    for (const part of imageParts) {
      const img = part.querySelector('img');
      if (img && img.src && !seen.has(img.src)) {
        seen.add(img.src);
        attachments.push({
          src: img.src,
          alt: img.alt || 'Image attachment',
          messageId: this.getMessageId(part),
        });
      }
    }

    // Also find blob images not in message parts
    const blobImages = document.querySelectorAll(ClankerSelectors.IMAGE_BLOB);
    for (const img of blobImages) {
      if (img.src && !seen.has(img.src)) {
        seen.add(img.src);
        attachments.push({
          src: img.src,
          alt: img.alt || 'Image attachment',
          messageId: this.getMessageId(img),
        });
      }
    }

    return attachments;
  },

  /**
   * Get recent images (for LLM context)
   * @param {number} limit
   * @returns {ImageAttachment[]}
   */
  getRecentImages(limit = 3) {
    const allImages = this.findAllImages();
    return allImages.slice(-limit);
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
   * Find message elements within a DOM node
   * @param {Element} node
   * @returns {Element[]}
   */
  findMessageElements(node) {
    const messages = [];

    // Check if node itself is a message
    if (node.matches && node.matches(ClankerSelectors.MESSAGE_CONTENT)) {
      messages.push(node);
    }

    // Find messages within the node
    if (node.querySelectorAll) {
      const found = node.querySelectorAll(ClankerSelectors.MESSAGE_CONTENT);
      messages.push(...found);
    }

    return messages;
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
      document.querySelector(ClankerSelectors.MESSAGE_WRAPPER) ||
      document.querySelector(ClankerSelectors.MESSAGE_CONTENT)
    );
  },
};

// Export for use by content.js
// In Chrome extension content scripts, we use window to share between scripts
window.ClankerParser = ClankerParser;
window.ClankerSelectors = ClankerSelectors;
window.ClankerPatterns = ClankerPatterns;
