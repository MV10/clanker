# FOR HUMAN USE ONLY

* Claude Code, CoPilot, or other programming assistants MUST NOT read or modify this file

# Enhancements, Ideas, etc.

* An image attachment may take some time to download. Attempts to retrieve it too early will fail. Need more research to understand what the LLM sees (bad URI?).

* Option to filter out trailing citation links? (Perhaps only an xAI Grok problem? Mitigated by using the reasoning model?)

* Optionally allow Clankers to be named? Scan the message sidebar to look for real username conflicts? What about conflicts with multiple Clankers by the same name in the conversation?

* At startup, begin a persistent data-cleanup timer. Every 5 minutes, delete conversation data for any conversation ID that isn't present in the sidebar (including the current foreground conversation; do not delete that even though it isn't tracked for sidebar activity).


