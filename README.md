# clanker

> DO NOT USE ... WORK-IN-PROGRESS

Clanker is an experimental Chromium browser extension which allows an OpenAI-compliant LLM such as Grok, ChatGPT or even locally-hosted AIs to participate in your Google Messages SMS conversations.

You will require an API key but costs should be very low. Analysis of a real, active, 3 hour conversation between two people estimated the Grok API would incur less than one cent of processing time (January 2026 rates).

## Installation & Configuration

It is unlikely Google would allow this in the Web Store, so you must "sideload" it.
 
* Clone the repository locally
* Open `chrome://extensions/` (or `brave://extensions/` or equivalent)
* Enable `Developer mode`
* Click `Load unpacked`
* Select the `extension` subdirectory

To update, either pull the latest changes to your clone, or delete and re-clone. Use the "reload" button the browser's Extensions page, then reload your Google Messages page.

## Usage

Navigate to https://messages.google.com and select a conversation, then right-click in the browser window. You will see a `Clanker` sub-menu where you can modify the settings like your API key, user name (in case the AI wishes to address you specifically; your name is not visible in the chat data, unlike other participants).

Once it is configured, the context menu options become available:

* Disabled - the conversation is not parsed or sent anywhere
* Available - the conversation is parsed locally, the AI replies once when addressed by name 
* Active - the conversation is sent to the AI for processing for every response

New conversations are always in Disabled mode. It will remember which mode a conversation was in and restore it when the conversation is re-selected.

## Comments, Troubleshooting, etc.

You should follow the pinned [Update Notifications](https://github.com/MV10/clanker/issues/1) issue to be notified when the extension is updated. Google releases new versions of Messages frequently and it's possible the extension will need to match changes in the conversation data structures. 

Because Google uses the hideous abomination known as Angular, interaction with the page is difficult (specifically, clicking that "Send" button). When an AI is active the extension has to put the page into debug mode to simulate user keyboard input. Debug mode shows an ugly banner at the top of your window. Do not dismiss the banner, that will disable the interaction (it detaches the debugger).

Google Messages should only be active in a single tab (only one instance should connect to your phone on each computer, by design), but there may be some odd behaviors in the edge case if you have other copies open on other tabs or browser windows.

If you see a problem, need help, or just have questions, please open a new [Issue](https://github.com/MV10/clanker/issues) (this requires a Github account).
