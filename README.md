# Hexfit

Find the best way to rotate and place hex-node pieces on a hex grid, from a game screenshot (built for Mycopunk).

Everything runs in the browser: the screenshot is never uploaded.

1. Drop, choose or paste (Ctrl/⌘+V) a screenshot.
2. Check the detected board; click cells to add or remove them, or enter columns × rows.
3. Mark pieces as Mandatory / High / Medium / Optional / Skip, and choose which colors can rotate.
4. Find placements: shows the best layouts with each piece's rotation.

## Development

```sh
cd web
npm install
npm run dev
```

Test detection and solving on an image from the command line:

```sh
npx tsx scripts/detect-image.ts path/to/screenshot.png
npx tsx scripts/solve-image.ts path/to/screenshot.png
```

`detect_groups.py` is the original Python/OpenCV prototype of the detection.

Pushing to `main` deploys to GitHub Pages.
