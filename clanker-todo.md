# Enhancements, Ideas, etc.

* The settings page should respect system light/dark mode configuration, if available.

* API HTTP error handling. What happens when the money runs out?

* The LLM should maintain profile notes about each participant including interests and opinions which is stored in a JSON array keyed on participant name. This is sent send them with each request (as is already being done for summary and customization data) and the LLM should send back modifications with the response. Update the system prompt to explain this data and to consider these details when creating a response.
 
* Add a checkbox setting labeled "Allow idle-time news searches (hourly)" which is disabled by default. Add a numeric text input labeled "Maximum news site searches (1 to 100)" which is 10 by default, and accepts any integer value from 1 to 100. Add two numeric text inputs with one label, "Quiet hours start/stop (24hrs)" and make the start-time 21 and the end-time 9, and limit the inputs to the values 0 through 23. When idle-time news searches are enabled and the local system time is NOT within the "Quiet hours" period, after the active conversation has been idle for at least 2 hours, at one hour intervals instruct the LLM to scan for recent events of interest to the participants, and to decide whether to comment about it in the chat. The LLM should only comment when the news items are extremely unusual or interesting: ignore routine announcements, scheduled events, casual relevance, and other low-interest content. Instruct the LLM to search no more than the configured number of maximum news site searches.

* Add Diagnostics menu item "Show Conversation State (Sanitized)" as the second Diagnostics menu item. This works like the existing Conversation State option, but with sensitive data redacted for public sharing for support purposes. Change participant names to User001 amd User002 etc, and change phone number participant names to (001) XXX-XXX and (002) XXX-XXXX etc, also redact image blob URI GUIDs with Xs. Redact participant names and URLs in message content as well.

* Improve icon legibility (fewer colors, more contrast).

* Prompting should explain that multiple participants may run the extension. Any [clanker] prefix in message history "belongs" to the named participant (ie. "You" is the local user, which "owns" the LLM processing the prompt, but ${NAME} is a different user with another LLM instance activated from NAME's computer). The AI must recognize this distinction. If Clanker wishes to directly address another user's Clanker, it should refer to "NAME's Clanker". Similarly, the AI is told the local user's name (example, "Jon"), and should understand that a reference to "Jon's Clanker" refers to this instance, but "Jane's Clanker" is a different LLM (since the local user is not named "Jane"). In a conversation with multiple Clankers, if a user addresses "Clanker" without the name of the "owning" user, try to determine from context if another Clanker is already conversing on the topic to avoid unnecessary interruptions. However, any LLM is free to respond to anything at any time.

* Optionally allow Clankers to be named? Scan the message sidebar to look for real username conflicts? What about conflicts with multiple Clankers by the same name in the conversation?
