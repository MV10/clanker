# clanker

> POSSIBLY UNSAFE, MOSTLY UNTESTED WORK-IN-PROGRESS; DO NOT USE YET.

Clanker is an experimental Chromium browser extension which allows an OpenAI-compliant LLM such as Grok, ChatGPT or even locally-hosted AIs to participate in your Google Messages SMS conversations.

You will require an API key but costs should be very low. Analysis of a real, active, 3 hour conversation between two people estimated the Grok API would incur less than one cent of processing time (January 2026 rates).

## Installation & Configuration

It is unlikely Google would allow this in the Web Store, so you must "sideload" it.
 
* Clone the repository locally
* Open `chrome://extensions/` (or `brave://extensions/` or equivalent)
* Enable `Developer mode`
* Click `Load unpacked`
* Select the `extension` subdirectory

Navigate to https://messages.google.com and select a conversation, then right-click in the browser window. You will see a `Clanker` sub-menu where you can modify the settings like your API key, user name (in case the AI wishes to address you specifically; your name is not visible in the chat data, unlike other participants).

Once it is configured, the context menu options become available:

* Disabled - the conversation is not parsed or sent anywhere
* Available - the conversation is parsed locally, the AI is engaged once when "clanker" is mentioned
* Active - the conversation is sent to the AI for processing for every response

New conversations are always in Disabled mode. It will remember which mode a conversation was in and restore it when the conversation is re-selected.