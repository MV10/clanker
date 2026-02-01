Icon Placeholders Required
==========================

This extension requires PNG icons in the following sizes:
- icon16.png  (16x16 pixels)
- icon48.png  (48x48 pixels)
- icon128.png (128x128 pixels)

To create placeholder icons, you can:

1. Use any image editor to create simple colored squares
2. Use an online PNG generator
3. Use ImageMagick if available:
   convert -size 16x16 xc:#1a73e8 icon16.png
   convert -size 48x48 xc:#1a73e8 icon48.png
   convert -size 128x128 xc:#1a73e8 icon128.png

For production, replace with proper branded icons.
