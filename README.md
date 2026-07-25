# Vault

An offline-first Progressive Web App for storing passwords, cards, and notes — encrypted entirely on your device.

## Features

- **AES-256-GCM encryption** with a PBKDF2-derived key (210,000 iterations, SHA-256)
- **No servers, no accounts, no tracking** — everything stays in the browser's IndexedDB
- **Installable PWA** — works offline, add-to-home-screen support, auto-updates in place
- **Biometric quick-unlock** via WebAuthn (Face ID / Touch ID / fingerprint), where supported
- **CSV backup & restore** for portable, user-controlled backups

## Getting started

Vault is a static app — no build step, no dependencies.

1. Serve the `vault/` folder over `http://` or `https://` (browsers block storage on `file://`).
   ```bash
   npx serve vault
   ```
2. Open it in your browser and create a master password.
3. Optionally install it as an app using the **Install App** button or your browser's install prompt.

## Project structure

```
vault/
├── index.html      # App shell — markup, styles, and app logic all inlined
├── sw.js           # Service worker: offline caching + update handling
├── offline.html    # Fallback page shown on failed navigation with nothing cached
├── manifest.json   # PWA manifest
└── icons/          # App icons
```

## Security notes

- Your master password never leaves the device and is never stored — only a derived key is used to encrypt/decrypt your vault.
- Losing your master password means losing access to your data; there is no recovery mechanism by design.
- CSV backups are **unencrypted** — store them somewhere safe.

## Browser support

Requires a modern browser with support for the Web Crypto API, IndexedDB, and Service Workers (all current versions of Chrome, Edge, Firefox, and Safari). Biometric unlock requires WebAuthn platform authenticator support.
