# Overview
 
* Refer to the local README.md for a high level description
* The extension is restricted to processing pages from messages.google.com
* Processes conversational text and still-image attachments 
* During ongoing conversations, only process new comments, do not re-parse the entire page on each update
* LLM replies must be prefixed with "[clanker]" so human participants know it is LLM output
* The LLM will use the local user's input field and send button to participate in the conversation

# Extension Initialization
 
* Present warnings to the local user in a banner at the top of the page
* Warn the local user if critical configuration items are missing (Uninitialized mode): AI URI, key, model, or username
* After the page renders, warn the local user if the LLM can't recognize the page structure, then stop processing the page
* Disregard the page header, menus, user menu, and so on
* Evaluate the page content and find the active conversation region
* Separately catalog the inactive sidebar conversations
* Review the available conversation history and catalog all participants
* The program assigns conversation IDs which are part of the window URL and sidebar conversation anchor tags

# User-Initiated Foreground Conversation Switching
 
* The conversation the local user wants to use is called the foreground conversation
* Detect the foreground conversation ID from the URL path
* Monitor for URL changes (SPA navigation) and browser history events
* When the foreground conversation changes due to user activity:
  - Clear participant list and processed message IDs
  - Cancel any pending LLM response
  - Load stored conversation data (mode, summary, customization, profiles, last processed message, etc)
  - Restore mode from storage (Deactivated is default only for new/unknown conversations)
* Guard against race conditions during conversation switch:
  - Block message processing until conversation parse is complete
  - Use hybrid message tracking to handle temp > permanent ID conversion

## Messages While Away

* In some modes, the extension can temporarily switch the page to an inactive conversation.
* When returning to the user's foreground conversation, detect and handle messages that arrived while away:
  - Compare current messages against the stored last processed message
  - Use hybrid matching: try message ID first, fall back to content+sender match
  - In Active mode: consult LLM for any new human messages
  - In Available mode: consult LLM only if new messages mention Clanker
  - Fallback safety: skip if the trigger message already has a Clanker response following it

# Extension-Controlled LLM Behaviors 
 
* For LLM instructions, review system prompts in content-llm.js.
* In Active mode: LLM is consulted for ALL new human messages; LLM decides whether to respond (can return null)
* In Available mode: LLM is only invoked when "clanker" is mentioned; LLM is instructed that it MUST respond
* If the local user is already typing a message, the LLM should not respond
* Humans are slow; before responding, wait before replying to give the local user a chance to start typing
* If a new message arrives while a response is pending, cancel the pending response and evaluate the new message instead (debouncing)

## Relaxed Responsiveness

A "Relaxed responsiveness" checkbox (on by default) enables human-like reading delays and typing simulation.

### Reading Delay

When relaxed mode is on, the response delay is based on message content rather than a flat timer:
 
* Specific durations and ranges are defined in the code (do not document here; they may change)
* Text message delay scales with character count at a simulated reading speed (randomized range)
* Image messages add additional delay (randomized range)
* When multiple messages arrive in rapid succession, the reading delay extends (adds time for each new message) rather than resetting (the same response closure is reused)

When relaxed mode is off, the original flat 1.5-2 second random delay is used.

### Typing Simulation

After the LLM responds, the message is typed character-by-character into the input field:
 
* Specific durations and ranges are defined in the code (do not document here; they may change)
* The `[clanker]` prefix is inserted immediately
* Remaining characters are inserted one at a time via `execCommand('insertText')`
* Base typing speed is a randomized characters-per-second (cps) range
* Each character has a randomized jitter delay added on top
* Total typing time is capped at 8 seconds
* Typing simulation is skipped when the per-character delay would be under 0.5ms

### User-Typing Protection

A race condition existed where the MAIN world script could overwrite user input that started after `waitForInputClear` passed but before the script executed. This is fixed by:

* The MAIN world script checks the textarea content before clearing; if non-empty and not UI text (SMS/RCS labels), it returns a `user_typing` error instead of destroying the input
* `sendMessage` retries up to 5 times with 1-second delays on `user_typing` errors
* If retries are exhausted, the error is logged to the console (not shown as a visible notification to the user)

### Send Serialization

Multiple `sendMessage` calls are serialized via a promise queue so each call waits for the previous one to complete. This prevents:
* Overlapping typing simulations corrupting each other (e.g. a second LLM response trying to type while the first is still being typed into the textarea)
* The MAIN world script misidentifying the extension's own partially-typed content as user input (`user_typing` false positive)

The `isUserTyping()` check in `attemptResponse` is also skipped when `state.sendingMessage` is true, since the textarea content belongs to the extension's typing simulation, not the user.

### Sidebar Send-In-Progress Guard

While a message is being sent (including during typing simulation), a `sendingMessage` flag prevents sidebar processing from navigating away from the foreground conversation. This protects against:
* Typing simulation writing characters into the wrong conversation's input field
* Partial or corrupted messages being sent to the wrong conversation
* Post-send data (summaries, profiles, customization) being saved to the wrong conversation ID

The flag is set for the entire duration of `sendMessage` (from input-clear wait through typing simulation and message submission) and is checked by both the foreground availability gate and the sidebar pipeline-completion wait.

### Sidebar Exceptions

* Sidebar "process" mode: all delays and typing simulation are skipped (instant response)
* Sidebar "idle" mode: reading delays and typing simulation apply normally when relaxed mode is on

## Concurrency Control
 
* Track LLM request IDs to invalidate superseded requests
* Prevent overlapping LLM requests with an in-flight flag
* Validate request ID before sending response (discard if superseded)
* Cancel pending responses when mode changes or conversation switches

# Conversation Summarization

To bound token growth and manage context efficiently, the extension uses a hybrid approach combining conversation summaries with recent literal messages.

## Response Format

* If the LLM returns plain text (not JSON), it's treated as the response with no summary update
* Some models occasionally ignore the instructions to always return JSON
* The LLM is instructed to respond with JSON as follows:
 
* For a text-response: `{"response": "message", "summary": "...", "customization": "..."}`
* TODO - document participant profile array
* The `response` field contains the chat message (without [clanker] prefix), or `null` to skip responding
* The `summary` field is optional and updates the stored conversation summary
* The `customization` field is optional and updates the stored persona/style directive

* For an image request: `{"requestImage": "blob:https://..."}`
* The `requestImage` field can request image data using the src attribute

## Null Responses
* 
* The LLM can return `{"response": null}` when it decides not to respond
* Use null responses when: the message doesn't warrant input, others are having a private exchange, or there's nothing meaningful to add
* The LLM can still update internal data (summary, customization, profiles, etc) even when not responding: `{"response": null, "summary": "..."}`
* Internal data fields can be left `undefined` to avoid modifying currently stored data

## Hybrid Context Strategy
 
* Recent messages are sent literally to preserve conversational context
* Message history size is configurable (10-500, default 20, recommended 50)
* Available message history is arbitrarily altered and constrained by Angular SPA page DOM content
* Older messages are represented by an LLM-managed summary stored per-conversation
* The summary is included as a system message: `[CONVERSATION SUMMARY - older messages not shown]`
* This bounds token usage while preserving important historical context
* LLM system prompts explain how the LLM should maintain summary data

## Summary Storage
 
* Summaries are stored in IndexedDB keyed by conversation ID (`summary_{conversationId}`)
* Summaries persist across browser sessions
* Summaries are cleared when switching conversations (loaded fresh for each conversation)

# Persona Customization

Users can request the LLM adopt different personas or communication styles. These customizations are managed by the LLM and stored separately from conversation summaries.

## How Customization Works
 
* Users request customization via natural language: "Clanker, talk like a pirate"
* The LLM evaluates the request and stores a directive: "Speak in pirate dialect"
* The customization is sent with each subsequent request as `[ACTIVE CUSTOMIZATION]`
* The LLM can update customization by returning `{"customization": "new directive"}`
* The LLM can clear customization by returning `{"customization": null}`
* The LLM must reject requests that conflict with core behavior

## Customization Storage
 
* Customizations are stored in IndexedDB keyed by conversation ID (`customization_{conversationId}`)
* Customizations persist across browser sessions
* Customizations are separate from summaries (different purposes, different update frequency)
* Customizations are cleared when switching conversations

# Image Handling

Images in the conversation are optimized for LLM consumption using an on-demand fetch approach.

## Inline Image Format
 
* Images appear inline in the conversation flow as messages
* Format: `Sender: [IMAGE: blob:https://messages.google.com/...] "alt text"`
* This preserves conversational context (what led to the image, what responses followed)
* The LLM cannot directly access blob URLs used by Google Messages

## Requesting Image Data
 
* The LLM can request image data by responding: `{"requestImage": "blob:https://messages.google.com/..."}`
* The extension fetches the image, optimizes it, and makes a follow-up API request with the image data
* Only one image can be requested at a time
* The LLM should only request images when the content is relevant to the response
* When viewing an image, the LLM should consider adding a description to the summary for future context

## Image Optimization
 
* Long edge is scaled to a multiple of 448 pixels (matching vision model tile size)
* Maximum dimension is 1344 pixels (448 × 3 tiles)
* Images are compressed as JPEG with 0.8 quality
* Optimized images are sent as base64 data URLs

## Image Caching
 
* The most recently optimized image is cached in memory (by src URL)
* Cache is also persisted to IndexedDB per-conversation (`image_cache_{conversationId}`)
* Cache is used when the same image is requested again

# Error Handling
 
* Display non-blocking notifications to the user for errors (bottom-right corner, auto-dismiss)
* Notify when the LLM service is unreachable or returns an error
* Log detailed errors to the browser console for debugging

# Operating Modes

The extension operates in one of four modes, controlled via a browser context menu (right-click).

## Uninitialized
* The extension is not configured (missing API key, endpoint, model, or local user name)
* This mode is automatic when configuration is incomplete
* Not shown in the context menu
* Other modes are unavailable until configuration is complete
* A warning banner is displayed to the user

## Deactivated (Default)
* The conversation is not monitored by the extension
* The LLM is never invoked
* This is the default mode for any new conversation
* No message processing occurs

## Available
* The extension tracks the conversation locally
* Message history is maintained for context
* The LLM is only invoked when "clanker" appears in a new message
* Use this mode when you want the AI available on-demand without active participation

## Active
* The extension is fully running and calling the LLM
* LLM is consulted for every new human message
* LLM decides whether to respond (can return null to skip)
* The LLM participates naturally in the conversation

## Context Menu
* Right-click on the Google Messages page to access the Clanker menu
* Mode options are shown as radio buttons with a checkmark on the active mode
* "Settings..." opens the configuration page
* Mode options are disabled when in Uninitialized mode
* A Diagnostics menu entry shows sub-menu

## Mode Transition Messages

When modes change, the extension inserts a message to inform conversation participants:

* **Any >> Available**: Extension inserts "[clanker] AI is available but will only reply if you address it directly by name."
* **Any >> Active**: LLM generates a brief activation message (e.g., "Hey everyone, I'm here!")
* **Any >> Deactivated**: Extension inserts "[clanker] The AI has been deactivated for this conversation."

The LLM-generated activation message receives context about the conversation and a one-time instruction to announce its presence briefly and casually.

# Extension Storage

## IndexedDB (persistent)

* Uses IndexedDB database "ClankerDB" with object store "settings"
* Shared storage module (storage.js) provides async get/set/remove/clear operations
* Works in both page context and service worker context

### Global Settings

* `apiEndpoint` - LLM API endpoint URL
* `apiKey` - LLM API key
* `model` - LLM model identifier
* `userName` - Local user's display name (replaces "You" in LLM context)
* `historySize` - Number of recent messages to send literally (10-500, default 20)
* `relaxedResponsiveness` - Enable human-like reading/typing delays (boolean, default true)

### Per-Conversation Data

* `mode_{conversationId}` - Operating mode for the conversation
* `summary_{conversationId}` - LLM-generated conversation summary
* `customization_{conversationId}` - Active persona/style directive
* TODO - document participant profile data
* `lastMessage_{conversationId}` - Last processed message (id, content, sender) for hybrid tracking
* `image_cache_{conversationId}` - Cached optimized image data

## Per-Conversation Mode Storage

* Operating mode is stored per-conversation in IndexedDB (`mode_{conversationId}`)
* Mode persists across browser sessions and tab closures
* Mode is restored when returning to a conversation
* New/unknown conversations default to Deactivated

## API Endpoint Validation

* Endpoint URL must be valid http:// or https:// URL
* Non-localhost endpoints must use https://
* Localhost URLs (localhost, 127.0.0.1, ::1, *.local) may use http:// for local LLM development
* Validation occurs both when saving settings and before each API request
* TODO - document endpoint overrides (currently only xAI)

# Sidebar Inactive Conversation Processing

The extension can only interact with the single foreground conversation loaded in the main content area. This feature monitors the sidebar conversation list for new messages in non-foreground conversations and briefly navigates to them for LLM processing before returning to the user's foreground conversation.

## Sidebar Mode Configuration

A settings dropdown ("Inactive Conversation Response") controls behavior with three options:

* **Ignore new messages** (default): Sidebar is not monitored at all. No observer is created, no processing occurs.
* **Process new messages**: New messages in non-foreground conversations are processed as soon as the foreground is available (user is not typing, no LLM request in flight, no pending response timer, no message being sent or typed, no conversation change in progress).
* **Respond when idle (10min)**: New messages are queued but only processed after 10 minutes of foreground inactivity. Activity is defined as receiving new messages, user input activity, or LLM activity.

The setting is stored in IndexedDB as `sidebarMode`.

## Change Detection

* A MutationObserver watches the conversation list element for `childList`, `subtree`, and `characterData` changes
* Mutations are debounced (500ms) before processing
* On each batch, all sidebar conversation items are scanned
* The current foreground conversation and any conversation being actively processed are skipped
* Each conversation's snippet text is compared against a stored snapshot (`pendingSnippets` map)
* If unchanged, the conversation is skipped
* If changed but the snippet starts with `"You:"`, it is an outgoing message and skipped
* On initialization, a full snapshot of all conversation snippets is captured as the baseline

## Conversation Evaluation

When a snippet change is detected, the conversation is evaluated against its stored mode:
* No stored mode or Deactivated mode -- skip (never process conversations the user hasn't activated)
* Available mode -- only process if the snippet text mentions Clanker
* Active mode -- always process
* Conversations that pass evaluation are added to the todo queue (if not already present)

## Processing Orchestration

### Queue and Timing
* The todo queue holds conversation IDs awaiting processing
* Only one conversation is processed at a time (`isProcessing` flag)
* In **Process** mode: processing begins as soon as the foreground is available (checked via 2-second polling, 2-minute timeout)
* In **Idle** mode: processing waits for 10 minutes of foreground inactivity (checked via 30-second polling)
* Both modes require foreground availability (not typing, no LLM in flight, no pending timer, no message being sent/typed, not changing conversations)

### Navigation and Processing
1. Store the current foreground conversation ID as the return target
2. Display a banner: "Clanker is processing an inactive conversation, please wait..."
3. Find the sidebar anchor for the target conversation and click it
4. Wait for the conversation change to be confirmed (poll `state.currentConversationId`, 200ms interval, 10s timeout)
5. The existing conversation-change pipeline handles loading: `handleConversationChange` >> `parseExistingConversation` >> mode restore >> message processing >> LLM invocation
6. Wait for the pipeline to complete: `parseComplete` is true, no LLM in flight, no pending response timer, no message being sent/typed, plus a 1-second settle period for sent messages to appear in the DOM (polled at 500ms, 60s safety timeout)
7. Process the next conversation in the queue, or return to the foreground

### Return to Foreground
* After all queued conversations are processed, navigate back to the stored foreground conversation ID
* The return navigation uses the same click-and-wait mechanism
* All processing flags are cleared and the banner is removed

## User Intervention

If the user manually changes the conversation while sidebar processing is in progress:
* The conversation observer detects that the navigation was not initiated by the sidebar module (`isSidebarNavigation()` returns false while `isProcessing()` returns true)
* The new conversation is removed from the todo queue if present
* The entire queue is cleared (the user took control)
* The `userIntervened` flag is set, causing all pending waits (navigation, processing) to abort
* Processing finishes and the banner is removed
* The sidebar module does not attempt to return to the original foreground

## Activity Tracking Integration

Multiple modules feed into the sidebar activity timestamp:
* **content-observers.js** -- URL changes, history events, input field mutations
* **content-messages.js** -- New messages processed
* **content-llm.js** -- LLM requests started and completed

This timestamp is used by idle mode to determine when 10 minutes of inactivity have elapsed.

## Sidebar State

All sidebar state is in-memory only (cleared on page refresh):
* `sidebar.mode` — Current sidebar mode (ignore/process/idle)
* `sidebar.todoQueue` — Array of conversation IDs awaiting processing
* `sidebar.returnToConversationId` — Foreground conversation to return to after processing
* `sidebar.isProcessing` — True while navigating and processing sidebar conversations
* `sidebar.currentlyProcessingId` — The conversation currently being processed
* `sidebar.lastActivityTimestamp` — Last foreground activity time
* `sidebar.idleTimeoutMs` — Idle threshold (10 minutes)
* `sidebar.idleCheckTimer` — Timer handle for periodic idle checks
* `sidebar.pendingSnippets` — Map of conversation ID to last known snippet text

The following top-level state fields are also checked by sidebar processing:
* `state.sendingMessage` — True while `sendMessage` is executing (blocks sidebar navigation)

## Deferred LLM Responses

If an LLM request is in-flight when the user switches conversations (including sidebar-initiated switches), the response is not discarded. Instead:
* The origin conversation ID and last message ID are captured before the LLM call
* When the response arrives and the request is superseded (conversation changed), it is stored in `state.deferredResponse`
* When the user returns to the original conversation, `parseExistingConversation` checks for a matching deferred response
* If the last message ID still matches (no new messages arrived while away), the deferred response is delivered
* If new messages arrived, the deferred response is discarded (stale context)
* Only one deferred response is stored at a time (single slot, in-memory only)
