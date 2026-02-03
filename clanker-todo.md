# Enhancements, Ideas, etc.

* "Cannot recognize page structure" warning shows too soon when the page loads slowly. Detect page-load?

* For long-running conversations, have the LLM generate and update notes about each participant, areas of interest, etc, and store these with conversation data, and send them with each request.
 
* During long idle periods, scan for recent events of interest and decide whether to comment about it in the chat

* Add Diagnostics menu item "Deactivate All Conversations".

* Add Diagnostics menu item "Show Sanitized Conversation State" for public sharing for support requests; change participant names to User001 amd User002 etc, and change phone number participant names to (001) XXX-XXX and (002) XXX-XXXX etc, also redact image blob URI GUIDs with Xs.

* Improve icon legibility (fewer colors, more contrast).

* Prompting should explain that multiple participants may run the extension. Any [clanker] prefix in message history "belongs" to the named participant (ie. "You" is the local user, which "owns" the LLM processing the prompt, but ${NAME} is a different user with another LLM instance activated from NAME's computer). The AI must recognize this distinction. If Clanker wishes to directly address another user's Clanker, it should refer to "NAME's Clanker". Similarly, the AI is told the local user's name (example, "Jon"), and should understand that a reference to "Jon's Clanker" refers to this instance, but "Jane's Clanker" is a different LLM (since the local user is not named "Jane"). In a conversation with multiple Clankers, if a user addresses "Clanker" without the name of the "owning" user, try to determine from context if another Clanker is already conversing on the topic to avoid unnecessary interruptions. However, any LLM is free to respond to anything at any time.

* Optionally allow Clankers to be named? Scan the message sidebar to look for real username conflicts?

## Inactive Sidebar Conversation Response

* Add a config-page checkbox (off by default) for Respond to Inactive Conversations and apply these rules when true:
* Create separate parser-sidebar.js and content-sidebar.js modules for the work described here
* Detect changes to the conversation list in the sidebar
* The foreground conversation is also in the sidebar; ignore sidebar changes for the foreground conversation
* Ignore changes to conversations which either have no stored state data, or are in the Deactivated state
* If the sidebar conversation is in Available mode but the new message doesn't address Clanker, ignore the change
* If the user is typing or an LLM request is in flight, wait for completion (response arrives in history or LLM does not reply)
* Once the foreground conversation is idle, store the foreground conversation ID then navigate to the updated sidebar conversation
* For the duration of the sidebar handling, note and store other sidebar changes (except the original conversation) but do not react
* Allow the LLM to respond to the conversation and wait for the response to appear in history
* If other sidebar changes were stored, process the next one with the same rules
* Once all sidebar changes are handled, navigate back to the original foreground conversation and resume normal processing

## Conversation Sidebar Structure

Each conversation in the sidebar is an <a> element with class list-item and role option. The structure:

 <a class="list-item" href=".../conversations/{CONVERSATION_ID}"  
    data-e2e-conversation=""    
    data-e2e-is-pinned="true/false"
    data-e2e-is-muted="true/false"
    data-e2e-is-unread="true/false"
    aria-selected="true/false">

    <div class="avatar-container">
      <mws-conversation-avatar>...</mws-conversation-avatar>
    </div>

    <div class="text-content">
      <h2 class="name">
        <span data-e2e-conversation-name="">Dad, Mom</span>
      </h2>
      <div data-e2e-conversation-snippet="">
        <mws-conversation-snippet>
          <span>You: [clanker] Sweet, headin' down?...</span>
        </mws-conversation-snippet>
      </div>
    </div>

    <div class="list-item-info">
      <mws-relative-timestamp class="snippet-timestamp">
        4:11 AM
      </mws-relative-timestamp>
      <button data-e2e-conversation-list-item-menu=""
              aria-label="Options for Dad, Mom">
      </button>
    </div>
 </a>                                                                                                   

### Key Data Elements

* Conversation ID — Encoded in the href attribute, extractable via /conversations/([^/?]+). Format is base64-like (likely protobuf), e.g. CghQyd_jHAdh-hICNTg. The active conversation can retrieve the ID from window.location.href.

* Participants — Plain text in <span data-e2e-conversation-name="">. Single name for 1:1, comma-separated for groups (e.g. "Dad, Mom", "Hammy, Sherry"). No IDs, phone numbers, or individual metadata.

* Message snippet — Only one message is stored, the most recent. Format is "Sender: message text" or "You: message text". No message ID or timestamp is attached to the snippet itself. The message is complete, even though the display is truncated.

* Timestamp — Relative only in the DOM ("4:11 AM", "Mon", "Jan 25"). No absolute timestamps, epoch values, or ISO dates in data attributes or aria-labels. The <mws-relative-timestamp> has a <span class="weekday-aria-label"> with the  
full day name for accessibility, but no hidden absolute time.

* State flags — data-e2e-is-pinned, data-e2e-is-muted, data-e2e-is-unread (all "true"/"false" strings).

### Notable Limitations

- No absolute timestamps anywhere in the sidebar DOM
- No participant IDs or contact details — names only
- No message count or additional message history
- No message ID on the snippet
- Your assumption is correct: only one recent message is available per conversation item

