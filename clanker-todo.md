# Enhancements, Ideas, etc.

* Edge-case bug: person A posts a reply, LLM starts processing, person B starts a reply, LLM response arrives but is added to conversation twice.

* "Cannot recognize page structure" warning shows too soon when the page loads slowly. Detect page-load?

* I think the extension either aborts or delays contacting the LLM if the user has started typing in the input textarea field. However, the LLM can take a few seconds to respond. If the user begins typing during that wait, this is not detected and the LLM response gets mixed with the user's content. The LLM can be contacted even if the user has started typing, but the LLM output should be delayed until the textarea is empty.

* For long-running conversations, have the LLM generate and update notes about each participant, areas of interest, etc, and store these with conversation data, and send them with each request.
 
* During long idle periods, scan for recent events of interest and decide whether to comment about it in the chat

* Add Diagnostics menu item "Deactivate All Conversations".

* Add Diagnostics menu item "Show Sanitized Conversation State" for public sharing for support requests; change participant names to User001 amd User002 etc, and change phone number participant names to (001) XXX-XXX and (002) XXX-XXXX etc, also redact image blob URI GUIDs with Xs.

* Improve icon legibility (fewer colors, more contrast).

* Prompting should explain that multiple participants may run the extension. Any [clanker] prefix in message history "belongs" to the named participant (ie. "You" is the local user, which "owns" the LLM processing the prompt, but ${NAME} is a different user with another LLM instance activated from NAME's computer). The AI must recognize this distinction. If Clanker wishes to directly address another user's Clanker, it should refer to "NAME's Clanker". Similarly, the AI is told the local user's name (example, "Jon"), and should understand that a reference to "Jon's Clanker" refers to this instance, but "Jane's Clanker" is a different LLM (since the local user is not named "Jane"). In a conversation with multiple Clankers, if a user addresses "Clanker" without the name of the "owning" user, try to determine from context if another Clanker is already conversing on the topic to avoid unnecessary interruptions. However, any LLM is free to respond to anything at any time.

* Optionally allow Clankers to be named? Scan the message sidebar to look for real username conflicts?


