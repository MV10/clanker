/**
 * Clanker Logging Module
 * Centralized logging with source and conversation ID prefixes.
 * Format: [Clanker:source:ID] message  or  [Clanker:source] message
 */

const ClankerLog = (function() {
  'use strict';

  function formatPrefix(source, conversationId) {
    return conversationId
      ? `[Clanker:${source}:${conversationId}]`
      : `[Clanker:${source}]`;
  }

  function info(source, conversationId, ...args) {
    console.log(formatPrefix(source, conversationId), ...args);
  }

  function warn(source, conversationId, ...args) {
    console.warn(formatPrefix(source, conversationId), ...args);
  }

  function error(source, conversationId, ...args) {
    console.error(formatPrefix(source, conversationId), ...args);
  }

  return { info, warn, error };
})();

if (typeof self !== 'undefined') {
  self.ClankerLog = ClankerLog;
}
