# App icon

`icon.png` (1024²) is what the running app uses — `nativeImage` reads PNG and
JPEG only, so handing it the `.icns` silently yields an empty image and leaves
the stock Electron atom in the dock.

`icon.icns` is for packaging: electron-builder embeds it in the macOS bundle.

## Regenerating

The source of truth is `../../web/public/mark.svg` plus the layout in
`icon-source.html`, which follows the macOS Big Sur grid — an 824/1024 body
with a 22.4% corner radius, and a simplified flatter treatment at 16/32px
where the mark's detail cannot survive.

```sh
npx electron assets/render-icons.cjs /tmp/icons assets/icon-source.html
# then, on macOS:
#   arrange the PNGs into bulletz.iconset/ using Apple's naming
#   iconutil -c icns bulletz.iconset -o assets/icon.icns
```

Known limitation: `mark.svg` is a 248-path autotrace of a bitmap, so edges are
slightly ragged at 512px and above. A clean vector original would fix that.
