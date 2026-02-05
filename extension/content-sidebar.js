/**
 * Clanker Sidebar Module
 * Monitors non-foreground sidebar conversations for new messages.
 * When changes are detected, navigates to the conversation, lets the
 * existing LLM pipeline process it, then returns to the foreground.
 */

(function() {
  'use strict';

  const Log = window.ClankerLog;
  const LOG_SOURCE = 'Sidebar';
  const SidebarParser = window.ClankerSidebarParser;
  const ClankerPatterns = window.ClankerPatterns;
  const Storage = window.ClankerStorage;
  const { state, MODES } = window.ClankerState;

  let sidebarObserver = null;
  let sidebarInitiatedNavigation = false;
  let userIntervened = false;
  let availabilityCheckTimer = null;
  let debounceTimer = null;

  // ── Initialization ──────────────────────────────────────────────

  /**
   * Initialize sidebar monitoring based on config
   */
  function initialize() {
    const mode = state.config?.sidebarMode || 'ignore';
    state.sidebar.mode = mode;

    if (mode === 'ignore') {
      Log.info(LOG_SOURCE, null, 'Mode is "ignore", sidebar monitoring disabled');
      return;
    }

    Log.info(LOG_SOURCE, null, 'Initializing with mode:', mode);

    // Diagnostic: verify selectors match the actual DOM
    const listEl = document.querySelector(SidebarParser.SELECTORS.CONVERSATION_LIST);
    const items = SidebarParser.getAllConversationItems();
    Log.info(LOG_SOURCE, null, 'Conversation list element:', listEl?.tagName || 'NOT FOUND');
    Log.info(LOG_SOURCE, null, 'Conversation items found:', items.length);
    if (items.length > 0) {
      const first = items[0];
      Log.info(LOG_SOURCE, null, 'First item tag:', first.tagName,
        'id:', SidebarParser.getConversationId(first),
        'snippet:', SidebarParser.getSnippetText(first));
    } else {
      Log.warn(LOG_SOURCE, null, 'No conversation items found with selector:',
        SidebarParser.SELECTORS.CONVERSATION_ITEM);
    }

    state.sidebar.lastActivityTimestamp = Date.now();
    takeSnippetSnapshot();
    setupSidebarObserver();
  }

  // ── Activity Tracking ───────────────────────────────────────────

  /**
   * Update the last activity timestamp (called by observers, messages, LLM)
   */
  function updateActivity() {
    state.sidebar.lastActivityTimestamp = Date.now();
  }

  /**
   * Check if the foreground conversation has been idle for the configured timeout
   * @returns {boolean}
   */
  function isForegroundIdle() {
    return (Date.now() - state.sidebar.lastActivityTimestamp) >= state.sidebar.idleTimeoutMs;
  }

  /**
   * Check if the foreground is available for sidebar processing
   * (not typing, no LLM in flight, no pending timer, not sending a message, not changing conversations)
   * @returns {boolean}
   */
  function isForegroundAvailable() {
    return !state.userTyping &&
           !state.llmInFlight &&
           !state.pendingResponseTimer &&
           !state.sendingMessage &&
           !state.conversationChanging;
  }

  // ── Sidebar Observer ────────────────────────────────────────────

  /**
   * Set up a MutationObserver on the sidebar conversation list
   */
  function setupSidebarObserver() {
    const listEl = document.querySelector(SidebarParser.SELECTORS.CONVERSATION_LIST);
    if (!listEl) {
      Log.warn(LOG_SOURCE, null, 'Conversation list element not found, retrying in 2s');
      setTimeout(setupSidebarObserver, 2000);
      return;
    }

    sidebarObserver = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(handleSidebarMutations, 500);
    });

    sidebarObserver.observe(listEl, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    Log.info(LOG_SOURCE, null, 'Observer started on conversation list');
  }

  /**
   * Take a snapshot of all current sidebar snippet texts
   */
  function takeSnippetSnapshot() {
    const items = SidebarParser.getAllConversationItems();
    Log.info(LOG_SOURCE, null, 'Taking snippet snapshot, items:', items.length);
    for (const item of items) {
      const id = SidebarParser.getConversationId(item);
      if (id) {
        const text = SidebarParser.getSnippetText(item);
        state.sidebar.pendingSnippets.set(id, text);
      }
    }
    Log.info(LOG_SOURCE, null, 'Snapshot captured for', state.sidebar.pendingSnippets.size, 'conversations');
  }

  /**
   * Handle debounced sidebar mutations — detect new messages in non-foreground conversations
   */
  function handleSidebarMutations() {
    if (state.sidebar.mode === 'ignore') return;

    const items = SidebarParser.getAllConversationItems();
    if (items.length === 0) return;

    for (const item of items) {
      const conversationId = SidebarParser.getConversationId(item);
      if (!conversationId) continue;

      // Skip the current foreground conversation
      if (conversationId === state.currentConversationId) continue;

      // Skip conversation currently being processed by sidebar
      if (conversationId === state.sidebar.currentlyProcessingId) continue;

      // Skip automated-message conversations (participant name is a digits-only number)
      const conversationName = SidebarParser.getConversationName(item);
      if (ClankerPatterns.AUTOMATED_PARTICIPANT.test(conversationName)) continue;

      const snippetText = SidebarParser.getSnippetText(item);
      const previousSnippet = state.sidebar.pendingSnippets.get(conversationId);

      // Skip if snippet hasn't changed
      if (snippetText === previousSnippet) continue;

      Log.info(LOG_SOURCE, conversationId,
        'Snippet changed | old:', JSON.stringify(previousSnippet), '| new:', JSON.stringify(snippetText));

      // Update stored snapshot
      state.sidebar.pendingSnippets.set(conversationId, snippetText);

      // Skip outgoing messages (our own, including clanker responses)
      if (snippetText.startsWith('You:')) {
        Log.info(LOG_SOURCE, conversationId, 'Skipping outgoing message');
        continue;
      }

      // Evaluate whether this conversation should be processed
      evaluateConversation(conversationId, snippetText).then(shouldProcess => {
        Log.info(LOG_SOURCE, conversationId, 'Evaluate result:', shouldProcess);
        if (shouldProcess && !state.sidebar.todoQueue.includes(conversationId)) {
          Log.info(LOG_SOURCE, conversationId, 'Queuing conversation');
          state.sidebar.todoQueue.push(conversationId);
          attemptProcessing();
        }
      }).catch(err => {
        Log.error(LOG_SOURCE, conversationId, 'Evaluate error:', err);
      });
    }
  }

  // ── Evaluation ──────────────────────────────────────────────────

  /**
   * Evaluate whether a conversation should be processed based on stored mode and snippet
   * @param {string} conversationId
   * @param {string} snippetText
   * @returns {Promise<boolean>}
   */
  async function evaluateConversation(conversationId, snippetText) {
    try {
      const modeKey = `mode_${conversationId}`;
      const stored = await Storage.get([modeKey]);
      const conversationMode = stored[modeKey];

      Log.info(LOG_SOURCE, conversationId, 'Stored mode:', conversationMode || '(none)');

      // No stored mode or deactivated → skip
      if (!conversationMode || conversationMode === MODES.DEACTIVATED) {
        return false;
      }

      // Available mode: only process if snippet mentions clanker
      if (conversationMode === MODES.AVAILABLE && !SidebarParser.snippetMentionsClanker(snippetText)) {
        Log.info(LOG_SOURCE, conversationId, 'Available mode but no clanker mention, skipping');
        return false;
      }

      // Active mode or Available+mentioned → process
      return true;
    } catch (e) {
      Log.warn(LOG_SOURCE, conversationId, 'Error evaluating conversation:', e);
      return false;
    }
  }

  // ── Processing Orchestration ────────────────────────────────────

  /**
   * Attempt to start processing the queue based on sidebar mode conditions
   */
  function attemptProcessing() {
    Log.info(LOG_SOURCE, null, 'attemptProcessing: queue=', state.sidebar.todoQueue.length,
      'isProcessing=', state.sidebar.isProcessing, 'mode=', state.sidebar.mode);

    if (state.sidebar.isProcessing) return;
    if (state.sidebar.todoQueue.length === 0) return;

    const mode = state.sidebar.mode;

    if (mode === 'idle') {
      if (!isForegroundIdle()) {
        Log.info(LOG_SOURCE, null, 'Not idle yet, scheduling idle check');
        scheduleIdleCheck();
        return;
      }
    } else if (mode === 'process') {
      if (!isForegroundAvailable()) {
        Log.info(LOG_SOURCE, null, 'Foreground not available, scheduling availability check');
        scheduleAvailabilityCheck();
        return;
      }
    }

    beginProcessing();
  }

  /**
   * Schedule periodic idle check (30s interval)
   */
  function scheduleIdleCheck() {
    if (state.sidebar.idleCheckTimer) return;

    state.sidebar.idleCheckTimer = setInterval(() => {
      if (state.sidebar.mode === 'ignore' || state.sidebar.todoQueue.length === 0) {
        clearInterval(state.sidebar.idleCheckTimer);
        state.sidebar.idleCheckTimer = null;
        return;
      }

      if (isForegroundIdle() && isForegroundAvailable()) {
        clearInterval(state.sidebar.idleCheckTimer);
        state.sidebar.idleCheckTimer = null;
        if (!state.sidebar.isProcessing) {
          beginProcessing();
        }
      }
    }, 30000);
  }

  /**
   * Schedule periodic availability check (2s interval, 2min timeout)
   */
  function scheduleAvailabilityCheck() {
    if (availabilityCheckTimer) return;

    let elapsed = 0;
    const interval = 2000;
    const timeout = 120000;

    availabilityCheckTimer = setInterval(() => {
      elapsed += interval;

      if (state.sidebar.mode === 'ignore' || state.sidebar.todoQueue.length === 0) {
        clearInterval(availabilityCheckTimer);
        availabilityCheckTimer = null;
        return;
      }

      if (elapsed >= timeout) {
        // Timed out — clear timer but re-attempt later instead of losing queued items
        clearInterval(availabilityCheckTimer);
        availabilityCheckTimer = null;
        Log.info(LOG_SOURCE, null, 'Availability check timed out, will retry in 30s');
        setTimeout(attemptProcessing, 30000);
        return;
      }

      if (isForegroundAvailable()) {
        clearInterval(availabilityCheckTimer);
        availabilityCheckTimer = null;
        if (!state.sidebar.isProcessing) {
          beginProcessing();
        }
      }
    }, interval);
  }

  /**
   * Begin processing the sidebar queue
   */
  function beginProcessing() {
    state.sidebar.isProcessing = true;
    state.sidebar.returnToConversationId = state.currentConversationId;
    userIntervened = false;
    Log.info(LOG_SOURCE, null, 'Beginning processing, return-to:', state.sidebar.returnToConversationId);

    // Show banner over input area
    const banner = document.createElement('div');
    banner.className = 'clanker-sidebar-banner';
    banner.textContent = 'Clanker is processing an inactive conversation, please wait...';
    document.body.appendChild(banner);

    processNextInQueue();
  }

  /**
   * Process the next conversation in the queue (recursive)
   */
  async function processNextInQueue() {
    // If queue is empty, return to foreground
    if (state.sidebar.todoQueue.length === 0) {
      returnToForeground();
      return;
    }

    const conversationId = state.sidebar.todoQueue.shift();
    state.sidebar.currentlyProcessingId = conversationId;

    // Bail if mode changed while processing
    if (state.sidebar.mode === 'ignore') {
      Log.info(LOG_SOURCE, null, 'Mode changed to ignore, aborting');
      finishProcessing();
      return;
    }

    Log.info(LOG_SOURCE, conversationId, 'Processing conversation');

    // Find the sidebar anchor for this conversation
    const anchor = SidebarParser.findConversationAnchor(conversationId);
    if (!anchor) {
      Log.warn(LOG_SOURCE, conversationId, 'Anchor not found');
      state.sidebar.currentlyProcessingId = null;
      processNextInQueue();
      return;
    }

    // Navigate to the conversation and wait for it to load
    navigateToConversation(anchor);
    const navSuccess = await waitForNavigation(conversationId);
    if (!navSuccess) {
      Log.warn(LOG_SOURCE, conversationId, 'Navigation failed');
      state.sidebar.currentlyProcessingId = null;
      processNextInQueue();
      return;
    }

    // Now wait for the LLM pipeline to finish processing
    const completed = await waitForProcessingComplete();

    if (!completed) {
      // User intervened or timeout
      Log.info(LOG_SOURCE, null, 'Processing interrupted');
      finishProcessing();
      return;
    }

    state.sidebar.currentlyProcessingId = null;

    // Continue with next item
    processNextInQueue();
  }

  /**
   * Navigate to a conversation by clicking its sidebar anchor
   * @param {Element} anchor
   */
  function navigateToConversation(anchor) {
    sidebarInitiatedNavigation = true;
    anchor.click();

    // Clear the flag after 1s (enough for conversation observer to see it)
    setTimeout(() => {
      sidebarInitiatedNavigation = false;
    }, 1000);
  }

  /**
   * Wait for the conversation to actually change to the target ID
   * @param {string} targetConversationId
   * @returns {Promise<boolean>} true if navigation succeeded
   */
  function waitForNavigation(targetConversationId) {
    return new Promise(resolve => {
      let elapsed = 0;
      const interval = 200;
      const timeout = 10000;

      const timer = setInterval(() => {
        elapsed += interval;

        if (userIntervened) {
          clearInterval(timer);
          resolve(false);
          return;
        }

        if (elapsed >= timeout) {
          Log.warn(LOG_SOURCE, targetConversationId, 'Navigation timeout');
          clearInterval(timer);
          resolve(false);
          return;
        }

        if (state.currentConversationId === targetConversationId) {
          Log.info(LOG_SOURCE, targetConversationId, 'Navigation confirmed');
          clearInterval(timer);
          resolve(true);
        }
      }, interval);
    });
  }

  /**
   * Wait for the existing pipeline to finish processing the navigated conversation.
   * Called after waitForNavigation confirms the conversation loaded.
   * Waits for parseComplete + no pending LLM work, then a short settle.
   * @returns {Promise<boolean>} true if completed normally, false if interrupted
   */
  function waitForProcessingComplete() {
    return new Promise(resolve => {
      let elapsed = 0;
      const interval = 500;
      const timeout = 60000;
      let settleWait = 0;
      let settling = false;

      const timer = setInterval(() => {
        elapsed += interval;

        // User intervened
        if (userIntervened) {
          clearInterval(timer);
          resolve(false);
          return;
        }

        // Safety timeout
        if (elapsed >= timeout) {
          Log.warn(LOG_SOURCE, state.sidebar.currentlyProcessingId, 'Processing timeout');
          clearInterval(timer);
          resolve(true);
          return;
        }

        // Wait for parse complete + no pending or active LLM work + no message being sent
        if (state.parseComplete && !state.conversationChanging &&
            !state.llmInFlight && !state.pendingResponseTimer &&
            !state.sendingMessage) {
          if (!settling) {
            settling = true;
            settleWait = 0;
            Log.info(LOG_SOURCE, state.sidebar.currentlyProcessingId, 'Pipeline idle, settling...');
          }
          settleWait += interval;

          // Short settle for sent message to appear in DOM
          if (settleWait >= 1000) {
            Log.info(LOG_SOURCE, state.sidebar.currentlyProcessingId, 'Processing complete');
            clearInterval(timer);
            resolve(true);
          }
        } else {
          settling = false;
          settleWait = 0;
        }
      }, interval);
    });
  }

  /**
   * Return to the foreground conversation after processing
   */
  async function returnToForeground() {
    const returnId = state.sidebar.returnToConversationId;
    if (!returnId) {
      finishProcessing();
      return;
    }

    Log.info(LOG_SOURCE, returnId, 'Returning to foreground');
    const anchor = SidebarParser.findConversationAnchor(returnId);
    if (anchor) {
      navigateToConversation(anchor);
      await waitForNavigation(returnId);
    } else {
      Log.warn(LOG_SOURCE, returnId, 'Return anchor not found');
    }
    finishProcessing();
  }

  /**
   * Reset all processing flags
   */
  function finishProcessing() {
    state.sidebar.isProcessing = false;
    state.sidebar.currentlyProcessingId = null;
    state.sidebar.returnToConversationId = null;
    userIntervened = false;
    updateActivity();

    // Remove the processing banner
    const banner = document.querySelector('.clanker-sidebar-banner');
    if (banner) banner.remove();

    Log.info(LOG_SOURCE, null, 'Processing finished');
  }

  // ── User Intervention ───────────────────────────────────────────

  /**
   * Check if the current navigation was initiated by the sidebar module
   * @returns {boolean}
   */
  function isSidebarNavigation() {
    return sidebarInitiatedNavigation;
  }

  /**
   * Called by conversation observer when a non-sidebar navigation occurs during processing
   * @param {string} newConversationId
   */
  function notifyManualConversationChange(newConversationId) {
    Log.info(LOG_SOURCE, newConversationId, 'Manual conversation change detected');
    handleUserIntervention(newConversationId);
  }

  /**
   * Handle user taking control during sidebar processing
   * @param {string} newConversationId
   */
  function handleUserIntervention(newConversationId) {
    // Remove the new foreground from queue if present
    const idx = state.sidebar.todoQueue.indexOf(newConversationId);
    if (idx >= 0) {
      state.sidebar.todoQueue.splice(idx, 1);
    }

    // Clear the entire queue — user took control
    state.sidebar.todoQueue.length = 0;
    userIntervened = true;
  }

  // ── Exports ─────────────────────────────────────────────────────

  window.ClankerSidebar = {
    initialize,
    updateActivity,
    isSidebarNavigation,
    notifyManualConversationChange,
    isProcessing: () => state.sidebar.isProcessing,
  };

})();
