/**
 * Clanker Storage Module
 * Load/save functions for per-conversation state
 */

(function() {
  'use strict';

  const Log = window.ClankerLog;
  const LOG_SOURCE = 'Storage';
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
        Log.info(LOG_SOURCE, state.currentConversationId, 'Loaded conversation summary');
      }
    } catch (error) {
      Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to load conversation summary:', error);
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
      Log.info(LOG_SOURCE, state.currentConversationId, 'Saved conversation summary');
    } catch (error) {
      Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to save conversation summary:', error);
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
        Log.info(LOG_SOURCE, state.currentConversationId, 'Restored conversation mode:', storedMode);

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
        Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to load conversation mode:', error);
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
      Log.info(LOG_SOURCE, state.currentConversationId, 'Saved conversation mode:', mode);
    } catch (error) {
      Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to save conversation mode:', error);
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
        Log.info(LOG_SOURCE, state.currentConversationId, 'Loaded conversation customization');
      }
    } catch (error) {
      Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to load conversation customization:', error);
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
        Log.info(LOG_SOURCE, state.currentConversationId, 'Saved conversation customization');
      } else {
        // Allow clearing customization
        await Storage.remove(key);
        state.conversationCustomization = null;
        Log.info(LOG_SOURCE, state.currentConversationId, 'Cleared conversation customization');
      }
    } catch (error) {
      Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to save conversation customization:', error);
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
        Log.info(LOG_SOURCE, state.currentConversationId, 'Loaded conversation profiles');
      }
    } catch (error) {
      Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to load conversation profiles:', error);
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
        Log.info(LOG_SOURCE, state.currentConversationId, 'Saved conversation profiles');
      } else {
        await Storage.remove(key);
        state.conversationProfiles = null;
        Log.info(LOG_SOURCE, state.currentConversationId, 'Cleared conversation profiles');
      }
    } catch (error) {
      Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to save conversation profiles:', error);
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
        Log.info(LOG_SOURCE, state.currentConversationId, 'Loaded last processed message:', state.lastProcessedMessage.id);
      }
    } catch (error) {
      Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to load last processed message:', error);
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
      Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to save last processed message:', error);
    }
  }

  /**
   * Purge stored data for conversations no longer visible in the UI.
   * Compares conversation IDs in the database against the current foreground
   * conversation and all sidebar conversations; removes orphaned entries.
   */
  const CONVERSATION_KEY_PATTERN = /^(mode|summary|customization|profiles|image_cache|lastMessage)_(.+)$/;

  async function purgeOrphanedData() {
    try {
      // Collect all conversation IDs visible in the UI
      const visibleIds = new Set();
      if (state.currentConversationId) {
        visibleIds.add(state.currentConversationId);
      }
      const SidebarParser = window.ClankerSidebarParser;
      if (SidebarParser) {
        const items = SidebarParser.getAllConversationItems();
        for (const item of items) {
          const id = SidebarParser.getConversationId(item);
          if (id) visibleIds.add(id);
        }
      }

      // Safety: don't purge if we can't see any conversations
      // (sidebar not loaded, page not ready, etc.)
      if (visibleIds.size === 0) {
        Log.info(LOG_SOURCE, state.currentConversationId, 'No conversations visible, skipping orphan purge');
        return;
      }

      // Scan all stored keys for conversation-specific entries
      const allData = await Storage.getAll();
      const keysToRemove = [];
      const orphanedIds = new Set();

      for (const key of Object.keys(allData)) {
        const match = key.match(CONVERSATION_KEY_PATTERN);
        if (match) {
          const conversationId = match[2];
          if (!visibleIds.has(conversationId)) {
            keysToRemove.push(key);
            orphanedIds.add(conversationId);
          }
        }
      }

      if (keysToRemove.length > 0) {
        await Storage.remove(keysToRemove);
        Log.info(LOG_SOURCE, state.currentConversationId,
          `Purged ${keysToRemove.length} orphaned keys for ${orphanedIds.size} conversation(s)`);
      }
    } catch (error) {
      Log.warn(LOG_SOURCE, state.currentConversationId, 'Orphan purge failed:', error);
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
    saveLastProcessedMessage,
    purgeOrphanedData
  };

})();
