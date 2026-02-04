# Enhancements, Ideas, etc.

* An image attachment may take some time to download. Attempts to retrieve it too early will fail.

* Optionally allow Clankers to be named? Scan the message sidebar to look for real username conflicts? What about conflicts with multiple Clankers by the same name in the conversation?

* When "relaxed responsiveness" is enabled and the extension is simulating human typing of the LLM response, sometimes the code shows the "Failed to send message: user typing" error. That detection should be aware that it is the extension itself that is "typing", and it shouldn't be trying to send the message prematurely (as the error seems to suggest). After that problem is fixed, the "Failed to send message" error should not be a visible error message (but it should be logged to the console).

* When "relaxed responsiveness" is enabled and the extension is simulating human typing of the LLM response, and processing of inactive sidebar conversations is enabled and a new message arrives in an inactive conversation, the extension temporarily switches to the other conversation -- but this breaks the simulated typing. Upon returning to the main conversation, anything "typed" is lost and it randomly picks up further in the response (depending on how long it was focused on the inactive conversation). When typing, inactive conversations should be queued until the typing is done and the LLM message is sent.

* Add new Diagnostics menu selection "Purge Old Conversation Data" -- deletes conversation data for any conversation ID that isn't found in the sidebar.
