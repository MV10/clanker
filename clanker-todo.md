# Enhancements, Ideas, etc.

* Dual model support (cheap text-only, more expensive image support only when needed)
* For long-running conversations, take notes about participants areas of interest
* During long idle periods, scan for recent events of interest and decide whether to comment about it in the chat
* Notes about interests are restricted by conversation, the same user in a different chat will have separate data

* Init sequence after page refresh ... no content found, then a few seconds later, it finds it

* Init sequence after changing conversations ... no content found (runs too soon?)

* Shows warning banner about unrecognized page structure if no conversation is active yet
* Re-test: Doesn't go away even if a conversation is subsequently selected


* Verify that Available mode ignores the [clanker] prefix when checking whether the LLM was directly addressed.
* Verify that Active mode will not submit the LLM's own [clanker] prefixed output when the message history is updated.