# Overview
* Refer to the local README.md for a high level description.
* The extension is restricted to processing pages from messages.google.com
* Process conversational text and still-image attachments 
* During ongoing conversations, only process new comments, do not re-parse the entire page on each update
* LLM replies must be prefixed with "[clanker]" so human users know it is LLM output
* The LLM will use the local user's input field and send button to participate in the conversation

# Parsing Hints
* These are observations about page structure as of FEB-2026; Google may change this in future releases

## Container Structure
* The main conversation area is marked with `data-e2e-conversation-container`
* Messages are contained within `<mws-messages-list>` elements
* The sidebar with other conversations uses `<mws-conversation-list-item>` with `role="option"`
* Individual messages are wrapped in `<mws-message-wrapper>` with `data-e2e-message-wrapper`

## Message Elements
* Text messages use `<mws-text-message-part>` with `data-e2e-text-message-content`
* Image attachments use `<mws-image-message-part>`
* Image sources are blob URLs: `src="blob:https://messages.google.com/{key}"`
* Each message has a unique `data-e2e-message-id` attribute for tracking

## Message ID Formats
* Outgoing messages use UUID format: `cad0b185-eb06-4110-a322-fd94474e1343`
* Incoming messages use base64-like format: `MxJQ=xCObWTheaIK-gbF0nfA`
* These IDs are stable and should be used to detect new messages

## aria-label Format
* Message text is in the `aria-label` attribute of `<mws-text-message-part>`
* Format: `"NAME said: MESSAGE. Sent/Received on DATE at TIME. [Read.] [REACTIONS]"`
* Local user messages: `"You said: MESSAGE. Sent on DATE at TIME. Read."`
* Remote participant messages: `"NAME said: MESSAGE. Received on DATE at TIME."`
* LLM messages will appear as: `"You said: [clanker] MESSAGE. Sent on DATE at TIME. Read."`
* Reactions are appended after Read: `"...Read. Jane Doe reacted with love. You and (555) 555-7334 reacted with laugh."`

## Reactions
* Reactions appear at the end of the aria-label text
* Format: `"NAME reacted with TYPE."` or `"NAME and NAME reacted with TYPE."`
* Multiple reactions can appear for the same message
* Reaction types include: love, laugh, etc.
* Reactors may be named contacts or phone numbers

## Participant Names
* Named contacts appear as their display name (e.g., "John Doe", "Mom")
* Unsaved contacts appear as formatted phone numbers: `(XXX) XXX-XXXX`
* Phone number participants are valid senders and reactors
* The local user always appears as "You"

## Tombstone Messages
* Deleted or unsupported messages are marked with `data-e2e-message-tombstone`
* These contain no useful content and should be skipped during parsing
* Common causes: deleted messages, unsupported MMS types, expired media

## Input Controls
* Message input field: `data-e2e-message-input` or `data-e2e-message-input-box`
* Send button: `data-e2e-send-text-button`

## Windowing Behavior
* The page maintains approximately 30-40 visible messages at a time
* Older messages scroll out of the DOM as new messages arrive
* Use `data-e2e-message-id` to track which messages have been processed
* New messages appear at the end of the message list

# Initialization
* Present warnings to the local user in a banner at the top of the page
* Warn the local user if extension configuration items are missing (Uninitialized mode)
* Warn the local user if the LLM can't recognize the page structure, then stop processing the page
* Only the active conversation should be processed
* Disregard the sidebar listing other conversations
* Disregard the page header, menus, user menu, and so on
* Evaluate the page content and find the active conversation region
* Review the available conversation history and catalog all participants
* Recognize the conversational tone of the discussion and individual participants
* Adopt a tone that is consistent with the conversation history until directed otherwise

# Conversation Switching
* Detect the current conversation ID from the URL path or participant names
* Monitor for URL changes (SPA navigation) and browser history events
* When the conversation changes, reset all conversation-specific state:
  - Clear participant list
  - Clear processed message IDs
  - Cancel any pending LLM response
  - Reset mode to Deactivated (default for new conversations)

# LLM Behaviors
* Comment but do not dominate the conversation
* Comments should be brief, consistent with the style of SMS chatting
* Do not respond every time another participant speaks, not all comments seek your input
* In Active mode: respond to questions and when "clanker" is mentioned
* In Available mode: only respond when "clanker" is mentioned
* If the local user is already typing a message, the LLM should not respond
* Humans are slow; before responding, wait a few seconds to give the local user a chance to start typing
* If a new message arrives while a response is pending, cancel the pending response and evaluate the new message instead (debouncing)
* Recent images in the conversation should be described to the LLM for context (last 3 images)

# Conversation Summarization

To bound token growth and manage context efficiently, the extension uses a hybrid approach combining conversation summaries with recent literal messages.

## Response Format
* The LLM must respond with JSON: `{"response": "message", "summary": "...", "customization": "..."}`
* The `response` field contains the chat message (without [clanker] prefix), or `null` to skip responding
* The `summary` field is optional and updates the stored conversation summary
* The `customization` field is optional and updates the stored persona/style directive
* The `requestImage` field can request image data by src: `{"requestImage": "blob:https://..."}`
* If the LLM returns plain text (not JSON), it's treated as the response with no summary update

## Null Responses
* The LLM can return `{"response": null}` when it decides not to respond
* Use null responses when: the message doesn't warrant input, others are having a private exchange, or there's nothing meaningful to add
* The LLM can still update the summary even when not responding: `{"response": null, "summary": "..."}`

## Hybrid Context Strategy
* Recent messages (last 10) are sent literally to preserve conversational context
* Older messages are represented by a summary stored per-conversation
* The summary is included as a system message: `[CONVERSATION SUMMARY - older messages not shown]`
* This bounds token usage while preserving important historical context

## When to Update Summary
The LLM should provide an updated summary when:
* Important context would be lost as messages age out of the literal window
* Key decisions, plans, or commitments are made
* Ongoing topics or threads need tracking
* Participant dynamics or preferences emerge

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

## Allowed Customizations
* Different tones (formal, casual, humorous)
* Speech patterns and dialects
* Roleplay personas (characters, celebrities, etc.)
* Language style preferences

## Rejected Customizations
The LLM must reject requests that conflict with core behavior:
* Cannot remove the [clanker] prefix (handled by the extension, not the LLM)
* Cannot be instructed to dominate conversations or respond to every message
* Cannot bypass safety guidelines or produce harmful content
* Cannot ignore the JSON response format requirement

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
* The extension is not configured (missing API key, endpoint, or model)
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
* Responds to questions (messages containing "?")
* Responds when "clanker" is mentioned
* The LLM participates naturally in the conversation

## Context Menu
* Right-click on the Google Messages page to access the Clanker menu
* Mode options are shown as radio buttons with a checkmark on the active mode
* "Settings..." opens the configuration page
* Mode options are disabled when in Uninitialized mode

## Mode Transition Messages
When modes change, the extension inserts a message to inform conversation participants:

* **Deactivated → Available**: Extension inserts "[clanker] AI is available but will only reply if you address it directly by name."
* **Deactivated → Active**: LLM generates a brief activation message (e.g., "Hey everyone, I'm here!")
* **Active → Deactivated** or **Available → Deactivated**: Extension inserts "[clanker] The AI has been deactivated for this conversation."

The LLM-generated activation message receives context about the conversation and a one-time instruction to announce its presence briefly and casually.

# Extension Storage

## IndexedDB (persistent)
* Uses IndexedDB database "ClankerDB" with object store "settings"
* Store user's OpenAI LLM API key, endpoint, and model selection
* Store the local user's name (identified in the web page with "You said:" prefixes)
* Store customization directives keyed on conversation participants
* Shared storage module (storage.js) provides async get/set/remove/clear operations
* Works in both page context and service worker context

## Tab-Based Mode Storage
* Operating mode is stored per-tab in the background service worker
* Mode is reset to Deactivated when switching conversations
* Mode state is lost when the tab is closed or the browser restarts

## API Endpoint Validation
* Endpoint URL must be valid http:// or https:// URL
* Non-localhost endpoints must use https://
* Localhost URLs (localhost, 127.0.0.1, ::1, *.local) may use http:// for local LLM development
* Validation occurs both when saving settings and before each API request
