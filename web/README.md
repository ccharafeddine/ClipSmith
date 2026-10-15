# Web build for clip.chafic.me

`web/dist/` is a standalone static build of the ClipSmith web demo, built for the root of https://clip.chafic.me/.

- Base path `/`, no CDN, every file 25 MiB or smaller (the ffmpeg.wasm core is split into parts).
- `_headers` sets COOP/COEP (`same-origin` / `require-corp`), needed for SharedArrayBuffer.
- `_redirects` gives the SPA fallback (`/* /index.html 200`); `404.html` is a copy of the app.
- Favicon, Open Graph and Twitter meta and `og.png` are included.

The source lives in the MediaSmith monorepo (`apps/smiths-web`). Rebuild with:

```
SMITH_SITE=clip npm run build -w @mediasmith/smiths-web
```

then copy `apps/smiths-web/dist-site/clip/` here. See `docs/hosting.md` in MediaSmith for details.