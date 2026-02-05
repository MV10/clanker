/**
 * Clanker IndexedDB Storage Module
 * Provides persistent storage using IndexedDB instead of chrome.storage.local
 */

'use strict';

const ClankerStorage = (function() {
  const DB_NAME = 'ClankerDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'settings';

  let dbInstance = null;

  /**
   * Open or create the database
   * @returns {Promise<IDBDatabase>}
   */
  function openDatabase() {
    if (dbInstance) {
      return Promise.resolve(dbInstance);
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open database: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        dbInstance = request.result;

        // Handle connection closing unexpectedly
        dbInstance.onclose = () => {
          dbInstance = null;
        };

        resolve(dbInstance);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
    });
  }

  /**
   * Get values for specified keys
   * @param {string|string[]} keys - Key or array of keys to retrieve
   * @returns {Promise<Object>} Object with key-value pairs
   */
  async function get(keys) {
    const db = await openDatabase();
    const keyArray = Array.isArray(keys) ? keys : [keys];

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const result = {};

      let pending = keyArray.length;
      if (pending === 0) {
        resolve(result);
        return;
      }

      for (const key of keyArray) {
        const request = store.get(key);

        request.onsuccess = () => {
          if (request.result) {
            result[key] = request.result.value;
          }
          pending--;
          if (pending === 0) {
            resolve(result);
          }
        };

        request.onerror = () => {
          reject(new Error(`Failed to get key "${key}": ${request.error?.message}`));
        };
      }
    });
  }

  /**
   * Set values for specified keys
   * @param {Object} items - Object with key-value pairs to store
   * @returns {Promise<void>}
   */
  async function set(items) {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onerror = () => {
        reject(new Error(`Failed to save: ${transaction.error?.message}`));
      };

      for (const [key, value] of Object.entries(items)) {
        store.put({ key, value });
      }
    });
  }

  /**
   * Remove specified keys
   * @param {string|string[]} keys - Key or array of keys to remove
   * @returns {Promise<void>}
   */
  async function remove(keys) {
    const db = await openDatabase();
    const keyArray = Array.isArray(keys) ? keys : [keys];

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onerror = () => {
        reject(new Error(`Failed to remove: ${transaction.error?.message}`));
      };

      for (const key of keyArray) {
        store.delete(key);
      }
    });
  }

  /**
   * Clear all stored data
   * @returns {Promise<void>}
   */
  async function clear() {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.clear();

      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onerror = () => {
        reject(new Error(`Failed to clear: ${transaction.error?.message}`));
      };
    });
  }

  /**
   * Get all stored key-value pairs
   * @returns {Promise<Object>}
   */
  async function getAll() {
    const db = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const result = {};
        for (const item of request.result) {
          result[item.key] = item.value;
        }
        resolve(result);
      };

      request.onerror = () => {
        reject(new Error(`Failed to get all: ${request.error?.message}`));
      };
    });
  }

  // Public API
  return {
    get,
    set,
    remove,
    clear,
    getAll
  };
})();

// Export for use in other scripts (works in both window and service worker contexts)
if (typeof self !== 'undefined') {
  self.ClankerStorage = ClankerStorage;
}
