/**
 * Clanker Images Module
 * Image optimization, caching, and dimension calculation
 */

(function() {
  'use strict';

  const Log = window.ClankerLog;
  const LOG_SOURCE = 'Images';
  const Storage = window.ClankerStorage;
  const { state, IMAGE_CONFIG } = window.ClankerState;

  /**
   * Cached image data (most recent optimized image)
   */
  let cachedImage = {
    src: null,        // Original blob URL
    messageId: null,  // Message containing the image
    dataUrl: null,    // Optimized base64 data URL
    width: null,
    height: null
  };

  /**
   * Calculate optimal dimensions for LLM image processing
   * Long edge should be a multiple of 448, up to 1344 max
   */
  function calculateOptimalDimensions(width, height) {
    const { TILE_SIZE, MAX_DIMENSION } = IMAGE_CONFIG;
    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);

    // Calculate target long edge (multiple of 448, max 1344)
    let targetLong = Math.min(
      Math.ceil(longEdge / TILE_SIZE) * TILE_SIZE,
      MAX_DIMENSION
    );

    // If original is smaller than one tile, use one tile
    if (longEdge < TILE_SIZE) {
      targetLong = TILE_SIZE;
    }

    // Calculate scale factor and short edge
    const scale = targetLong / longEdge;
    const targetShort = Math.round(shortEdge * scale);

    // Return in correct orientation
    if (width >= height) {
      return { width: targetLong, height: targetShort };
    } else {
      return { width: targetShort, height: targetLong };
    }
  }

  /**
   * Fetch and optimize an image from a blob URL
   * @param {string} blobUrl - The blob URL to fetch
   * @returns {Promise<{dataUrl: string, width: number, height: number}>}
   */
  async function fetchAndOptimizeImage(blobUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = () => {
        try {
          const { width, height } = calculateOptimalDimensions(img.naturalWidth, img.naturalHeight);

          // Create canvas and draw resized image
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          // Convert to JPEG with specified quality
          const dataUrl = canvas.toDataURL('image/jpeg', IMAGE_CONFIG.JPEG_QUALITY);

          resolve({ dataUrl, width, height });
        } catch (error) {
          reject(new Error(`Failed to process image: ${error.message}`));
        }
      };

      img.onerror = () => {
        reject(new Error('Failed to load image from blob URL'));
      };

      img.src = blobUrl;
    });
  }

  /**
   * Get or fetch the cached optimized image
   * @param {string} src - Image blob URL
   * @param {string} messageId - Message ID containing the image
   * @returns {Promise<{dataUrl: string, width: number, height: number}|null>}
   */
  async function getOptimizedImage(src, messageId) {
    // Return cached if same image
    if (cachedImage.src === src && cachedImage.dataUrl) {
      Log.info(LOG_SOURCE, state.currentConversationId, 'Using cached image');
      return {
        dataUrl: cachedImage.dataUrl,
        width: cachedImage.width,
        height: cachedImage.height
      };
    }

    // Try to load from IndexedDB
    const cacheKey = `image_cache_${state.currentConversationId}`;
    try {
      const stored = await Storage.get(cacheKey);
      if (stored[cacheKey] && stored[cacheKey].src === src) {
        Log.info(LOG_SOURCE, state.currentConversationId, 'Loaded image from IndexedDB cache');
        cachedImage = stored[cacheKey];
        return {
          dataUrl: cachedImage.dataUrl,
          width: cachedImage.width,
          height: cachedImage.height
        };
      }
    } catch (e) {
      Log.warn(LOG_SOURCE, state.currentConversationId, 'Failed to load cached image:', e);
    }

    // Fetch and optimize the image
    try {
      Log.info(LOG_SOURCE, state.currentConversationId, 'Fetching and optimizing image...');
      const optimized = await fetchAndOptimizeImage(src);

      // Update cache
      cachedImage = {
        src,
        messageId,
        dataUrl: optimized.dataUrl,
        width: optimized.width,
        height: optimized.height
      };

      // Store in IndexedDB
      await Storage.set({ [cacheKey]: cachedImage });
      Log.info(LOG_SOURCE, state.currentConversationId, 'Cached optimized image');

      return optimized;
    } catch (error) {
      Log.error(LOG_SOURCE, state.currentConversationId, 'Failed to optimize image:', error);
      return null;
    }
  }

  // Export to window for use by other content modules
  window.ClankerImages = {
    calculateOptimalDimensions,
    fetchAndOptimizeImage,
    getOptimizedImage
  };

})();
