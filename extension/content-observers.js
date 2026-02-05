/**
 * Clanker Observers Module
 * Message, input, conversation, and visibility observers
 */

(function() {
  'use strict';

  const Log = window.ClankerLog;
  const LOG_SOURCE = 'Observers';
  const Parser = window.ClankerParser;
  const Selectors = window.ClankerSelectors;
  const { state, MODES } = window.ClankerState;
  const ConversationStorage = window.ClankerConversationStorage;

  /**
   * Set up MutationObserver to watch for new messages
   */
  function setupMessageObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Call processNewNodes from content-messages module
              if (window.ClankerMessages && window.ClankerMessages.processNewNodes) {
                window.ClankerMessages.processNewNodes(node);
              }
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    Log.info(LOG_SOURCE, state.currentConversationId, 'Message observer started');
  }

  /**
   * Set up observer for user typing in input field
   * Updates cached state for quick checks, but isUserTyping() is authoritative
   */
  function setupInputObserver() {
    const inputSelector = `${Selectors.INPUT_FIELD}, ${Selectors.INPUT_BOX}`;

    document.addEventListener('input', (event) => {
      const target = event.target;
      if (target.matches && target.matches(inputSelector)) {
        state.userTyping = target.textContent.trim().length > 0;
        if (window.ClankerSidebar) window.ClankerSidebar.updateActivity();
      }
    }, true);

    // On focus, check if there's actual content (don't assume typing just from focus)
    document.addEventListener('focusin', (event) => {
      if (event.target.matches && event.target.matches(inputSelector)) {
        state.userTyping = event.target.textContent.trim().length > 0;
        if (window.ClankerSidebar) window.ClankerSidebar.updateActivity();
      }
    }, true);

    document.addEventListener('focusout', (event) => {
      if (event.target.matches && event.target.matches(inputSelector)) {
        state.userTyping = event.target.textContent.trim().length > 0;
        if (window.ClankerSidebar) window.ClankerSidebar.updateActivity();
      }
    }, true);
  }

  /**
   * Set up observer to detect conversation switches
   */
  function setupConversationObserver() {
    let lastUrl = window.location.href;
    let conversationChangeTimer = null;
    let isProcessingChange = false;

    // Debounced handler for conversation changes
    function handlePotentialConversationChange() {
      // Skip if already processing a change
      if (isProcessingChange) return;

      // Immediately suppress message processing while we wait for the
      // DOM to settle.  The message observer fires from the same mutations
      // that trigger us, but it runs first (registered earlier).  Without
      // this, processNewNodes passes its guards because conversationChanging
      // is still false, producing a flood of spurious "Found wrapper" logs.
      state.conversationChanging = true;
      state.parseComplete = false;

      // Clear any pending timer
      if (conversationChangeTimer) {
        clearTimeout(conversationChangeTimer);
      }

      // Debounce: wait for DOM to settle before processing
      conversationChangeTimer = setTimeout(async () => {
        // Double-check we're not already processing
        if (isProcessingChange) return;

        const newConversationId = Parser.detectConversationId();
        if (newConversationId === state.currentConversationId) {
          // False alarm — same conversation, restore flags
          state.conversationChanging = false;
          state.parseComplete = true;
          return;
        }

        // Detect sidebar-initiated vs user-initiated navigation
        if (window.ClankerSidebar && !window.ClankerSidebar.isSidebarNavigation()
            && window.ClankerSidebar.isProcessing()) {
          window.ClankerSidebar.notifyManualConversationChange(newConversationId);
        }

        isProcessingChange = true;
        try {
          // Call handleConversationChange from content-main module
          if (window.ClankerMain && window.ClankerMain.handleConversationChange) {
            await window.ClankerMain.handleConversationChange(newConversationId);
          }
          // Wait a bit more for messages to load, then parse
          setTimeout(() => {
            // Call parseExistingConversation from content-messages module
            // parseExistingConversation manages state.parseComplete itself
            // (including during retry loops when messages haven't loaded yet)
            if (window.ClankerMessages && window.ClankerMessages.parseExistingConversation) {
              window.ClankerMessages.parseExistingConversation();
            }
            state.conversationChanging = false;   // Re-enable message processing
            isProcessingChange = false;
          }, 300);
        } catch (e) {
          state.parseComplete = true;
          state.conversationChanging = false;
          isProcessingChange = false;
          Log.warn(LOG_SOURCE, state.currentConversationId, 'Error during conversation change:', e);
        }
      }, 200);
    }

    const urlObserver = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        handlePotentialConversationChange();
      }
    });

    urlObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    window.addEventListener('popstate', () => {
      // Update lastUrl to stay in sync
      lastUrl = window.location.href;
      handlePotentialConversationChange();
    });
  }

  /**
   * Set up listener for tab visibility changes
   * Reloads conversation state when tab becomes visible (handles multi-tab sync)
   */
  function setupVisibilityListener() {
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && state.currentConversationId) {
        Log.info(LOG_SOURCE, state.currentConversationId, 'Tab became visible, reloading conversation state');
        try {
          await ConversationStorage.loadConversationMode();
          await ConversationStorage.loadConversationSummary();
          await ConversationStorage.loadConversationCustomization();
        } catch (e) {
          Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to reload conversation state:', e);
        }
      }
    });
  }

  // Export to window for use by other content modules
  window.ClankerObservers = {
    setupMessageObserver,
    setupInputObserver,
    setupConversationObserver,
    setupVisibilityListener
  };

})();
