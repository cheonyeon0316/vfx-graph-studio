# VFX Graph Studio

A browser-based viewer for validating, previewing, and saving VFX graph JSON. The renderer runs locally in your browser; graph JSON is not uploaded to a server.

## Use it

Open the [live studio](https://cheonyeon0316.github.io/vfx-graph-studio/) in a recent Chrome, Edge, or Firefox browser. Paste a graph JSON document or open a `.json` file, then choose **Render Graph**.

The studio also works as a static site. Open `index.html` directly, or serve this directory with any static web server. No build step, package install, API key, or backend is required.

## Supported input

- `pxf.graph@1` graphs
- `vfxlab.variations@1` collections
- VFX Lab `schemaVersion: 3` graphs with embedded PNG sprite frames

Supported PXF nodes: `Shape`, `Stroke`, `Particles`, `Sprite`, `Repeat`, `Blend`, `Glow`, `Palette`, `Tint`, and `Output`. Unsupported nodes are reported as errors. This is a browser preview subset, not full PXF or Unity runtime compatibility.

Saved effects stay in the current browser's IndexedDB and do not sync between devices. PNG frame assets must be embedded in the JSON; the renderer does not fetch external images.

## Files

- `index.html` — GitHub Pages entry point
- `graph-studio.html` — standalone studio page
- `graph-studio.js` — interface and browser-local library
- `graph-studio.css` — interface styles
- `graph-renderer-core.js` — graph validation and canvas renderer