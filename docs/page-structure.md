# Google Messages Parsing Hints

* Google Messages is an Angular SPA, so the DOM is machine-generated.
* Claude Code / Opus 4.5 produced this analysis.
* These are observations about valid as of FEB-2026.
* Google may change this in future releases requiring re-analysis.

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
* Temporary IDs use `tmp_` prefix: `tmp_615187582765` (not yet confirmed by server)
* Temp IDs are converted to permanent IDs by Google Messages after server confirmation
* Track messages using hybrid approach: ID primary, content+sender fallback for temp→permanent conversion

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

## Sidebar DOM Structure
* Each conversation in the sidebar is an anchor element:
* Selector: `a[data-e2e-conversation]`
* Conversation ID: extracted from the `href` attribute via `/conversations/([^/?#]+)`
* Participant names: `[data-e2e-conversation-name]` element text
* Message snippet: `mws-conversation-snippet span` element text (format: `"Sender: message text"` or `"You: message text"`)
* State flags: `data-e2e-is-pinned`, `data-e2e-is-muted`, `data-e2e-is-unread` (string booleans)
* Selected state: `aria-selected="true"` indicates the foreground conversation
* The conversation list container is the `<mws-conversations-list>` element
