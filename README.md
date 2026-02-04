# clanker <img src="https://github.com/MV10/clanker/blob/master/extension/icons/icon48.png"/>

Clanker is an _**experimental**_ Chromium browser extension which allows an OpenAI-compliant LLM such as Grok, ChatGPT or even locally-hosted AIs to participate in your Google Messages browser SMS conversations.

You will require an API key but costs should be very low. A real, active, 3 hour conversation between two people with participation by the Grok _grok-4-1-fast-non-reasoning_ model consumed about 1.5 cents of processing time (using January 2026 pricing, and minimal image processing).

## Installing & Updating

It is unlikely Google would allow this in the Web Store, so you must "sideload" it.
 
* Clone this repository (`git clone https://github.com/MV10/clanker.git`)
* Open `chrome://extensions/` (or `brave://extensions/` or equivalent)
* Enable `Developer mode`
* Click `Load unpacked`
* Select the `extension` subdirectory

To update, either pull the latest changes to your clone, or delete and re-clone. Use the "reload" button on the browser's Extensions page, then F5-refresh your Google Messages page.

## Required Settings

Navigate to https://messages.google.com and select a conversation, then right-click in the browser window. You will see a `Clanker` sub-menu. Choose `Settings` to view the configuration page. Minimally you must provide:

* API Endpoint
* API Key
* Model name
* User Name

Your name is not visible in the chat data, unlike other participants, so the AI needs to know who you are.

## Usage

Once it is configured, these context menu options become available:

* Deactivated - the conversation is not parsed or sent anywhere
* Available - the conversation is parsed locally, the AI replies only if addressed by name 
* Active - the conversation is sent to the AI for processing for every response

New conversations are always in Deactivated mode. It will remember which mode a conversation was in and restore it when the conversation is re-selected. There is an option in the Diagnostics sub-menu to instantly deactivate Clanker in all conversations. Only participants in the current active conversation will see a deactivation message.

Once Clanker is active in a conversation, any participant can address it by name by mentioning "Clanker" or "Clank" in their messages. The AI is instructed to _always_ respond when addressed by name, although some models may not reliably honor this. You can also give it specific directives, like, "Clank, talk like a pirate."

The AI itself doesn't remember anything from one interaction to the next. The extension lets the AI send back a conversation summary that is stored by your browser, and is re-sent with each new interaction. A partial history of the chat messages is also sent, and the AI is instructed to maintain the summary so that it "knows" about older parts of the discussion. The AI can also store your directives ("talk like a pirate") and these are also re-sent with each new interaction.

The AI can request a copy of images that are in the recent chat history. Videos and other attachment types are filtered out: the AI will not be aware that they even exist in the conversation. (If you _really_ want other content type, open an Issue and ask, but understand these can be extremely expensive to process.)

If your chosen API provider and model supports it, the AI can perform web searches, but it is instructed to minimize these unless absolutely necessary, or participants specifically tell it to access a URL. Most AI providers consider this "tool" usage and pricing can be much higher than simple conversation. API syntax for tool usage is not standardized; if you have one that isn't working, open an Issue and I'll try to address it. You must enable this on the Settings page.

Automated messages are always ignored. These are what phone carriers call A2P 10DLC (Automation-to-Person), which are messages sent from a 10-digit number (Amazon, your bank, 2-factor auth codes, flavor-of-the-week political campaigns, etc). If _any_ participant name is a 10-digit number, the conversation is ignored. Message content will not be read, and you can't activate the AI in those conversations. Only the Settings context-menu item is available when this type of conversation is active.

## Other Settings

"Message History Size" controls how many SMS messages are sent with each interaction. The range is 10 to 500, and 50 is recommended. Since each request sent to the AI is independent (stateless), all messages are re-parsed every time, so this can help control costs. Some AI providers can recognize and cache repeat data. Currently only xAI does this automatically, to my knowledge.

"Inactive Conversation Response" is disabled by default. The extension works best with the current conversation. By default, if you set Clanker to be Available or Active in a conversation and switch to a different conversation, other people sending texts to the first one won't get any AI responses until you switch back to that conversation. However, this setting allows the extension to _temporarily_ switch to another conversation when a message arrives to let the AI process the message and respond. This will interrupt you (momentarily changing the active conversation) if you're actively using Messages.

An alternative is "Respond when idle" which only does this after your foreground conversation has no activity for 10 minutes. It will track all the inactive conversations with new messages and process each of them. This lets Messages and the LLM work even while you're away, at least for as long as Messages thinks it's connected to your phone.

The "Allow web searches" checkbox is off by default, as most AI providers charge a hefty fee for tool usage.

The "Relaxed Responsiveness" checkbox is on by default. This emulates a more human-like response loop for the active conversation (and for inactive conversations in idle mode). This helps prevent the AI from appearing to dominate the conversation with instantaneous replies, which sometimes intimidates other participants into replying less often. When enabled, responsiveness varies based on message content, and the AI's replies are "typed" into the input box (showing others the "typing" notification, if enabled in Messages).

## Comments, Troubleshooting, etc.

You should follow the pinned [Update Notifications](https://github.com/MV10/clanker/issues/1) issue to be notified when the extension is updated. Google releases new versions of Messages frequently and it's possible the extension will need to match changes in the conversation data structures. 

Because Google uses the hideous abomination known as Angular, interaction with the page is difficult (specifically, clicking that "Send" button). When an AI is active the extension has to put the page into debug mode to simulate user keyboard input. Debug mode shows an ugly banner at the top of your window. Do not dismiss the banner, that will disable the interaction (it detaches the debugger).

Google Messages should only be active in a single tab (only one instance should connect to your phone on each computer, by design), but there may be some odd behaviors in the edge case if you have other copies open on other tabs or browser windows.

If you see a problem, need help, or just have questions, please open a new [Issue](https://github.com/MV10/clanker/issues) (this requires a Github account).

## LIABILITY DISCLAIMER

Use at your own risk. I explicitly disclaim any responsibility for anything that happens as a result of your use of this extension. It's open source, at a minimum, look at the end of [`content-llm.js`](https://github.com/MV10/clanker/blob/master/extension/content-llm.js) and read the system prompts that are sent to the AI which governs its behavior and responses. Use the Diagnostics menu to inspect the data it sends. You as the operator of this extension and the originator of the OpenAI API calls are responsible for anything your Clanker says and does. Probably. I'm not a lawyer and this is not legal advice.

In particular, it wouldn't surprise me if Google or your phone carrier gets their panties in a wad. It is apparently A-OK for _them_ to allow half the planet to blast us with automated spam 24/7, but you and I are "little people", not even blips on the almighty Quarterly Earnings Report. I have no specific knowledge of any policies this violates. Google prohibits "interfering with SMS" but this isn't interference, it is participation via their own public interface. All activity is fully visible and disclosed to all participants. Similarly, I don't think it violates phone carriers "A2P 10DLC" registration requirements (Automation-to-Person, which are messages from those 10-digit numbers you see telling you that your Anthropic billing agreement has drained your checking account). This isn't sales, marketing, service notifications, or anything else defined by A2P. It is simple entertainment delivered to specific private groups, and in fact the extension intentionally ignores those conversations altogether. But we walk in the shadows of humorless corporate behemoths. Buyer beware.
