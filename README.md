# GDSync — on-demand Google Drive sync for Obsidian

[日本語版 README はこちら / Japanese README](README.ja.md)

GDSync lets Obsidian on mobile (iOS/Android) read and write a vault stored in Google Drive **on demand**, without downloading the whole vault first.

- Mirrors the folder/file structure of a Drive folder into your vault (default `GDrive/`) as **zero-byte stub files** — Obsidian's file explorer and quick switcher work as usual
- Downloads a file's content **when you open it** (hydration)
- **Uploads edits automatically** (debounced a few seconds; conflicts are detected via checksums and preserved as `(conflict …)` copies)
- Files you have opened stay cached locally; old cache entries are automatically released back to stubs
- Create / rename / delete are propagated to Drive (deletions go to the Drive **trash**, never permanently deleted)
- On desktop, point your vault at a Google Drive for Desktop synced folder instead (the plugin is mobile-only by default)

## How it differs from other sync plugins

Existing community plugins (e.g. *Google Drive Sync*, *Remotely Save*) replicate the **entire** remote vault locally. GDSync instead keeps only a lightweight stub tree and fetches file content lazily, so it works well for large vaults (many GB of PDFs/images) on phones with limited storage. It is an *on-demand cache*, not a full replica.

## Requirements, network use, and privacy disclosure

- **Account required:** a Google account and your **own** Google Cloud OAuth client (free). GDSync ships no developer credentials; you authenticate against your own Google Cloud project.
- **Network:** the plugin talks only to Google endpoints — `accounts.google.com`, `oauth2.googleapis.com`, and `www.googleapis.com` (Drive API). There is no third-party server and no telemetry.
- **Scope:** GDSync requests the full `https://www.googleapis.com/auth/drive` scope. The narrower `drive.file` scope is not sufficient because the plugin must read files created by other apps (e.g. Google Drive for Desktop). Because it is your own OAuth client, only your account can use it.
- **Full-Drive listing:** to build the mirror index, the plugin lists file *metadata* (names, IDs, checksums) of your My Drive. File *content* is downloaded only for files you open, inside the selected folder.
- **Credential storage:** the OAuth client ID/secret and tokens are stored **unencrypted** in the plugin's `data.json` inside your vault, like most sync plugins. Do not share your vault's `.obsidian` folder, and use a dedicated Google Cloud project so the credentials cannot affect anything else.
- **Clipboard:** written to exactly once, when you click *Copy code* to move your sign-in to another device. The plugin never reads the clipboard. The connection code contains your tokens — treat it like a password and delete it from wherever you sent it after use.
- **Local port:** during desktop sign-in the plugin briefly listens on `127.0.0.1:42813` (loopback only, never exposed to the network) to receive the OAuth redirect, then closes it.

## Setup

### 1. Google Cloud project (your own)

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/)
2. APIs & Services → Library → enable the **Google Drive API**
3. OAuth consent screen: User type = **External**, add the scope `https://www.googleapis.com/auth/drive`
4. Move the publishing status to **Production** (in Testing mode refresh tokens expire after 7 days). The "unverified app" warning is expected for a personal project — proceed via *Advanced → Go to…* with your own account
5. Credentials → Create OAuth client ID → type = **Desktop app**. Copy the client ID and client secret. No redirect URI needs to be registered.

That's the whole external setup — no page to deploy, no server to run.

<details>
<summary>Alternative: browser sign-in directly on mobile (redirect page)</summary>

If you cannot sign in on a desktop first (mobile-only setup), create the OAuth client as type **Web application** instead, deploy `redirect-page/index.html` to any static host (GitHub Pages, Cloudflare Pages, …), and register its URL as an authorized redirect URI. The page only forwards the authorization code to `obsidian://gdsync-auth` and handles no secrets (the flow also uses PKCE and a `state` check). Enter the same URL in the plugin's *Redirect URI* setting. If you also want desktop sign-in with a Web application client, additionally register `http://127.0.0.1:42813` as a redirect URI.
</details>

### 2. Install the plugin

**Community plugins (once accepted):** search for "GDSync" in Obsidian's community plugin browser.

**BRAT (beta):** install the BRAT plugin, then *Add beta plugin* → `https://github.com/surblue-git/gdsync`.

**Manual build:**

```
npm install
npm run build
```

Copy the generated `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/gdsync/` and enable the plugin.

### 3. Connect

**On desktop (or whichever device you set up first):**

1. Enter the client ID and client secret in the plugin settings
2. *Authenticate with Google* → approve in the browser → done (the plugin briefly listens on `127.0.0.1:42813` to catch the redirect)
3. *Test connection* to verify

**On your phone:**

1. On the connected desktop, settings → *Connection code* → *Copy code*
2. Send the code to your phone, paste it via *Enter code* in the plugin settings, then delete the message you used to transfer it — the code is equivalent to a password

The code also carries the shared settings — the Drive folder, mirror base folder, exclude and always-sync patterns, maximum file size, upload debounce, and freshness interval — so a new device needs no re-entry. Device-specific settings (cache retention/count, *Enable on desktop*) are deliberately left alone, and nothing is applied unless you paste a code on that device.

**Then, on the device that will sync (typically the phone):**

1. *Choose from list* to pick the Drive folder to sync (pasting a Drive URL also works)
2. *Run full scan* → the stub tree is created under `GDrive/`

The plugin UI is available in **English and Japanese**, following Obsidian's display-language setting.

## Daily use

- Open a file → it is downloaded on the spot (subsequent opens use the cache; remote updates are re-fetched)
- Edit → uploaded automatically a few seconds later
- Ribbon sync icon / *Sync now* command → send pending changes and pull remote changes
- Returning the app to the foreground also triggers a differential sync

## Safety design

- **Multiple guards against overwriting Drive with empty stubs** (edits to not-yet-downloaded files are never uploaded, with a warning)
- Deletions always go to the Drive **trash** (nothing is permanently deleted); local deletions follow your Obsidian trash preference
- On conflict both versions are kept (the local one as `name (conflict <timestamp>).md`)
- Offline edits are preserved and sent automatically when back online

## Limitations

- Google Docs/Sheets/Slides (native Google formats) and shortcuts are not synced
- Files above the *Maximum file size* setting (default 20 MB) are not downloaded
- Files with identical names in the same Drive folder are disambiguated with ` (1)` suffixes
- Requires the full `drive` scope rather than `drive.file` (see the disclosure section above)

## Releasing (for maintainers)

```
npm version patch   # also updates manifest.json / versions.json
git push && git push --tags
```

Pushing a tag triggers GitHub Actions, which builds and attaches `main.js`, `manifest.json`, and `styles.css` to a release.

## License

[MIT](LICENSE)
