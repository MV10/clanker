# FOR HUMAN USE ONLY

* **Claude Code**: DO NOT READ OR ALTER THIS FILE
* **CoPilot**: DO NOT READ OR ALTER THIS FILE
* **Programming AI Assistants**: DO NOT READ OR ALTER THIS FILE

# Enhancements, Ideas, Notes, etc.

* Eliminate all reliance on conversation header (participant list), only use conversation ID. Users can rename a conversation which will change any identifier generated from the header (which would orphan associated data). Purge the entire database after this code change.

* An image attachment may take some time to download. Attempts to retrieve it too early will fail. Need more research to understand what the LLM sees (bad URI?).

* Optionally allow Clankers to be named? Scan the message sidebar to look for real username conflicts? What about conflicts with multiple Clankers by the same name in the conversation?

* At startup, begin a persistent data-cleanup timer. Every 5 minutes, delete conversation data for any conversation ID that isn't present in the sidebar (including the current foreground conversation; do not delete that even though it isn't tracked for sidebar activity).

* Provide a context menu Diagnostics -> "Edit Conversation State" page to allow the user to modify the active conversation's stored summary, customization, and profile data. Include Save button (do not save changes automatically; user can close the page to cancel). Also show read-only runtime state and recent messages list below the edit/save area (same outputs as provided on the Show Conversation State page).



