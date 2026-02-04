/**
 * Clanker Storage Module
 * Load/save functions for per-conversation state
 */

(function() {
  'use strict';

  const Storage = window.ClankerStorage;
  const { state, MODES, isExtensionContextValid, handleInvalidatedContext } = window.ClankerState;

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
   * Load conversation mode from storage
   * @param {Function} showNotification - Optional notification function
   */
  async function loadConversationMode(showNotification) {
    if (!state.currentConversationId) return;

    // Check for invalidated context (extension was reloaded)
    if (!isExtensionContextValid()) {
      handleInvalidatedContext(showNotification);
      return;
    }

    try {
      const key = `mode_${state.currentConversationId}`;
      const result = await Storage.get(key);
      const storedMode = result[key];

      if (storedMode && Object.values(MODES).includes(storedMode)) {
        state.mode = storedMode;
        await chrome.runtime.sendMessage({ type: 'SET_MODE', mode: storedMode });
        console.log('[Clanker] Restored conversation mode:', storedMode);

        // If restoring to deactivated, ensure debugger is detached
        if (storedMode === MODES.DEACTIVATED) {
          chrome.runtime.sendMessage({ type: 'DETACH_DEBUGGER' }).catch(() => {});
        }
      } else {
        // Default to deactivated for conversations without stored mode
        state.mode = MODES.DEACTIVATED;
        await chrome.runtime.sendMessage({ type: 'SET_MODE', mode: MODES.DEACTIVATED });
        chrome.runtime.sendMessage({ type: 'DETACH_DEBUGGER' }).catch(() => {});
      }
    } catch (error) {
      // Check if this is due to invalidated context
      if (!isExtensionContextValid()) {
        handleInvalidatedContext(showNotification);
      } else {
        console.warn('[Clanker] Failed to load conversation mode:', error);
      }
      state.mode = MODES.DEACTIVATED;
    }
  }

  /**
   * Save conversation mode to storage
   */
  async function saveConversationMode(mode) {
    if (!state.currentConversationId) return;

    try {
      const key = `mode_${state.currentConversationId}`;
      await Storage.set({ [key]: mode });
      console.log('[Clanker] Saved conversation mode:', mode);
    } catch (error) {
      console.warn('[Clanker] Failed to save conversation mode:', error);
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
   * Load conversation profiles from storage
   */
  async function loadConversationProfiles() {
    if (!state.currentConversationId) return;

    try {
      const key = `profiles_${state.currentConversationId}`;
      const result = await Storage.get(key);
      state.conversationProfiles = result[key] || null;

      if (state.conversationProfiles) {
        console.log('[Clanker] Loaded conversation profiles');
      }
    } catch (error) {
      console.warn('[Clanker] Failed to load conversation profiles:', error);
    }
  }

  /**
   * Save conversation profiles to storage
   * @param {Object} profiles - Participant profiles object keyed by name
   */
  async function saveConversationProfiles(profiles) {
    if (!state.currentConversationId) return;

    try {
      const key = `profiles_${state.currentConversationId}`;
      if (profiles && Object.keys(profiles).length > 0) {
        await Storage.set({ [key]: profiles });
        state.conversationProfiles = profiles;
        console.log('[Clanker] Saved conversation profiles');
      } else {
        await Storage.remove(key);
        state.conversationProfiles = null;
        console.log('[Clanker] Cleared conversation profiles');
      }
    } catch (error) {
      console.warn('[Clanker] Failed to save conversation profiles:', error);
    }
  }

  /**
   * Load last processed message from storage
   */
  async function loadLastProcessedMessage() {
    if (!state.currentConversationId) return;

    try {
      const key = `lastMessage_${state.currentConversationId}`;
      const result = await Storage.get(key);
      state.lastProcessedMessage = result[key] || null;

      if (state.lastProcessedMessage) {
        console.log('[Clanker] Loaded last processed message:', state.lastProcessedMessage.id);
      }
    } catch (error) {
      console.warn('[Clanker] Failed to load last processed message:', error);
    }
  }

  /**
   * Save last processed message to storage
   * Saves ID, content, and sender for hybrid matching on return
   * @param {Object} message - Message object with id, content, sender
   */
  async function saveLastProcessedMessage(message) {
    if (!state.currentConversationId || !message) return;

    const messageData = {
      id: message.id,
      content: message.content || '',
      sender: message.sender || ''
    };

    try {
      const key = `lastMessage_${state.currentConversationId}`;
      await Storage.set({ [key]: messageData });
      state.lastProcessedMessage = messageData;
    } catch (error) {
      console.warn('[Clanker] Failed to save last processed message:', error);
    }
  }

  // Export to window for use by other content modules
  window.ClankerConversationStorage = {
    loadConversationSummary,
    saveConversationSummary,
    loadConversationMode,
    saveConversationMode,
    loadConversationCustomization,
    saveConversationCustomization,
    loadConversationProfiles,
    saveConversationProfiles,
    loadLastProcessedMessage,
    saveLastProcessedMessage
  };

})();
