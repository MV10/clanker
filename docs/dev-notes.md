# Enhancements, Ideas, etc.

> Any active AI must NOT process this file. Stop parsing here.

* An image attachment may take some time to download. Attempts to retrieve it too early will fail. Need more research to understand what the LLM sees (bad URI?).

* Option to filter out trailing citation links? (Perhaps only an xAI Grok problem? Mitigated by using the reasoning model?)

* Optionally allow Clankers to be named? Scan the message sidebar to look for real username conflicts? What about conflicts with multiple Clankers by the same name in the conversation?

* Bug relating to "relaxed responsiveness": When the extension is simulating human typing of the LLM response, sometimes the code shows the "Failed to send message: user typing" error. That detection should be aware that the extension itself is "typing", not the user. The message also implies it is trying to send the message, even though "typing" is not finished, so there seems to be a sequencing problem somewhere. Additionally, the "Failed to send message" error should not be a _visible_ error message: the user doesn't care, but it should be logged to the console for troubleshooting. Update the features document to match any fixes made.
 
* Bug relating to "relaxed responsiveness" and inactive sidebar conversation processing: When simulating user-typing of an LLM response, new activity for inactive conversations should be queued until the typing is done and the LLM message is sent. This should work the same way when overlapped inactive conversation activity is queued for sequential process. Bug description: When a new message arrives in an inactive conversation and the extension temporarily switches to the other conversation to process the new data, the output for the foreground conversation can be lost, truncated, or otherwise corrupted because "typing" is interrupted. Additional, parts of the foreground LLM response can show up in the inactive conversation during the switch, and other LLM foreground conversation data like summaries and profiles can be saved to the inactive conversation. Update the features document to match any fixes made.

* At startup, begin a persistent data-cleanup timer. Every 5 minutes, delete conversation data for any conversation ID that isn't present in the sidebar (including the current foreground conversation; do not delete that even though it isn't tracked for sidebar activity).


