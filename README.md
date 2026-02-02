# clanker

Clanker is an _**experimental**_ Chromium browser extension which allows an OpenAI-compliant LLM such as Grok, ChatGPT or even locally-hosted AIs to participate in your Google Messages SMS conversations.

You will require an API key but costs should be very low. Analysis of a real, active, 3 hour conversation between two people estimated participation by the Grok _grok-4-1-fast-non-reasoning_ model would incur around one cent of processing time using January 2026 pricing, and assuming no image processing.

## Installing & Updating

It is unlikely Google would allow this in the Web Store, so you must "sideload" it.
 
* Clone the repository locally
* Open `chrome://extensions/` (or `brave://extensions/` or equivalent)
* Enable `Developer mode`
* Click `Load unpacked`
* Select the `extension` subdirectory

To update, either pull the latest changes to your clone, or delete and re-clone. Use the "reload" button on the browser's Extensions page, then F5-refresh your Google Messages page.

## Configuration & Usage

Navigate to https://messages.google.com and select a conversation, then right-click in the browser window. You will see a `Clanker` sub-menu where you can modify the settings like your API endpoint and key, and your user name (which is used the AI wishes to address you specifically; your name is not visible in the chat data, unlike other participants).

Once it is configured, the context menu options become available:

* Disabled - the conversation is not parsed or sent anywhere
* Available - the conversation is parsed locally, the AI replies only if addressed by name 
* Active - the conversation is sent to the AI for processing for every response

New conversations are always in Disabled mode. It will remember which mode a conversation was in and restore it when the conversation is re-selected.

The LLM can request a copy of images that are in the recent chat history. Video or other attachment types are filtered out.

The extension works with the current conversation only. If you have it Available or Active in a conversation and switch to a different conversation, other people sending texts to the first one won't get any LLM responses until you switch back to that conversation.

## Comments, Troubleshooting, etc.

You should follow the pinned [Update Notifications](https://github.com/MV10/clanker/issues/1) issue to be notified when the extension is updated. Google releases new versions of Messages frequently and it's possible the extension will need to match changes in the conversation data structures. 

Because Google uses the hideous abomination known as Angular, interaction with the page is difficult (specifically, clicking that "Send" button). When an AI is active the extension has to put the page into debug mode to simulate user keyboard input. Debug mode shows an ugly banner at the top of your window. Do not dismiss the banner, that will disable the interaction (it detaches the debugger).

Google Messages should only be active in a single tab (only one instance should connect to your phone on each computer, by design), but there may be some odd behaviors in the edge case if you have other copies open on other tabs or browser windows.

If you see a problem, need help, or just have questions, please open a new [Issue](https://github.com/MV10/clanker/issues) (this requires a Github account).
