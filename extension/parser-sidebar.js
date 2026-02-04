/**
 * Clanker Sidebar Parser Module
 * DOM parsing for the sidebar conversation list
 */

(function() {
  'use strict';

  const SELECTORS = {
    CONVERSATION_LIST: 'mws-conversations-list',
    CONVERSATION_ITEM: 'a[data-e2e-conversation]',
    CONVERSATION_NAME: '[data-e2e-conversation-name]',
    SNIPPET_CONTENT: 'mws-conversation-snippet span',
  };

  /**
   * Extract conversation ID from an anchor element's href
   * @param {Element} anchorEl
   * @returns {string|null}
   */
  function getConversationId(anchorEl) {
    const href = anchorEl.getAttribute('href');
    if (!href) return null;
    const match = href.match(/\/conversations\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  /**
   * Get snippet text from a conversation item
   * @param {Element} anchorEl
   * @returns {string}
   */
  function getSnippetText(anchorEl) {
    const snippet = anchorEl.querySelector(SELECTORS.SNIPPET_CONTENT);
    return snippet ? snippet.textContent.trim() : '';
  }

  /**
   * Get participant/conversation name
   * @param {Element} anchorEl
   * @returns {string}
   */
  function getConversationName(anchorEl) {
    const nameEl = anchorEl.querySelector(SELECTORS.CONVERSATION_NAME);
    return nameEl ? nameEl.textContent.trim() : '';
  }

  /**
   * Check if conversation item is marked as unread
   * @param {Element} anchorEl
   * @returns {boolean}
   */
  function isUnread(anchorEl) {
    return anchorEl.getAttribute('data-e2e-is-unread') === 'true';
  }

  /**
   * Check if conversation item is currently selected (foreground)
   * @param {Element} anchorEl
   * @returns {boolean}
   */
  function isSelected(anchorEl) {
    return anchorEl.getAttribute('aria-selected') === 'true';
  }

  /**
   * Find the anchor element for a specific conversation ID
   * @param {string} conversationId
   * @returns {Element|null}
   */
  function findConversationAnchor(conversationId) {
    const items = document.querySelectorAll(SELECTORS.CONVERSATION_ITEM);
    for (const item of items) {
      if (getConversationId(item) === conversationId) {
        return item;
      }
    }
    return null;
  }

  /**
   * Get all conversation item elements
   * @returns {NodeList}
   */
  function getAllConversationItems() {
    return document.querySelectorAll(SELECTORS.CONVERSATION_ITEM);
  }

  /**
   * Check if snippet text mentions clanker
   * @param {string} text
   * @returns {boolean}
   */
  function snippetMentionsClanker(text) {
    return ClankerPatterns.CLANKER_MENTION.test(text);
  }

  // Export to window
  window.ClankerSidebarParser = {
    SELECTORS,
    getConversationId,
    getSnippetText,
    getConversationName,
    isUnread,
    isSelected,
    findConversationAnchor,
    getAllConversationItems,
    snippetMentionsClanker,
  };

})();
