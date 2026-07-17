# HJFY Split Reader

[![Zotero 8/9](https://img.shields.io/badge/Zotero-8%2F9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org/)
[![CI](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/ci.yml)
[![Release](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/release.yml/badge.svg)](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/release.yml)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Fetch HJFY translations for arXiv papers and open the source PDF and translation side by side in Zotero 8 / 9.

[简体中文](../README.md) | [English](README-en.md)

## Features

- Adds an item context-menu action: `Fetch HJFY translation and open in split view`
- Reuses an existing HJFY translation attachment when it already exists under the item
- Downloads and stores the translated PDF as a child attachment when HJFY already has a translated file
- Detects the exact arXiv version from the local PDF, attachment metadata, or item metadata so the source and translation versions match
- Selects the highest detected version when a parent item contains multiple source PDFs
- Keeps polling while HJFY downloads sources or delays publishing the finished PDF URL
- Opens the source PDF and translated PDF in a single split-view reader tab
- Makes the translated pane on the right the default primary pane, so the source pane follows its scrolling
- Keeps Split-View Reader capabilities such as pane swapping

## Screenshots

The screenshots below show the Chinese Zotero UI, which is the default presentation of this project.

### Context-menu entry

<p align="center">
  <img src="images/context-menu-zh.png" alt="Context-menu entry for fetching HJFY translation and opening split view" width="320" />
</p>

### Split-view reader

<p align="center">
  <img src="images/split-view-zh.png" alt="Side-by-side source PDF and translated PDF in Zotero" width="1100" />
</p>

## Current Scope

- Supported well: papers whose local PDF contains an arXiv version stamp, or whose attachment/item metadata contains a complete `arXiv ID + vN`
- Supported: HJFY source downloads, queued translation tasks, and delayed PDF URL availability
- Not yet automated: HJFY local-document upload flow, because `hjfy.top` currently requires login for uploads and task creation

If HJFY requires login to create a translation task, the plugin opens the corresponding HJFY page so you can continue there.

To avoid silently downloading an older translation, the action stops when only a base arXiv ID is available and the local PDF version cannot be determined. Select the specific PDF attachment or add a complete versioned ID to the attachment name/URL or the parent item's DOI, URL, or `Extra` field.

## Install

1. Go to [Releases](https://github.com/Infinity4B/zotero-hjfy-split-reader/releases)
2. Download the latest `.xpi`
3. In Zotero, open `Tools` -> `Plugins`
4. Click the gear icon -> `Install Plugin From File...`
5. Select the downloaded `.xpi`

## Usage

1. In Zotero, select one paper item or one PDF attachment under that paper
2. Right-click and choose `Fetch HJFY translation and open in split view`
3. The plugin will:
   - determine the exact arXiv version of the local PDF
   - find an existing translation attachment for that exact version
   - otherwise query `hjfy.top`
   - save the translated PDF under the same Zotero item if available
   - open the source PDF and translation in split view

## Development

```bash
npm install
npm start
```

Useful commands:

```bash
npm run build
npm run lint:check
```

Build output is written to `.scaffold/build/`, including:

- `.scaffold/build/hjfy-split-reader.xpi`
- `.scaffold/build/update.json`

## Third-Party Notices

This project includes original work and derivative work based on the following open-source projects:

- [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template): project structure, build tooling, and plugin scaffold. Licensed under `AGPL-3.0-or-later`.
- [zerolfl/zotero-split-view-reader](https://github.com/zerolfl/zotero-split-view-reader): split-view reader implementation and related UI assets, adapted and modified for this project. Licensed under `AGPL-3.0-or-later`.
- [ANGJustinl/zotero-plugin-hjfy](https://github.com/ANGJustinl/zotero-plugin-hjfy): HJFY API integration approach and attachment import flow, adapted and modified for this project. Licensed under `AGPL-3.0-or-later`.

Please see [LICENSE](../LICENSE) and the upstream repositories for their respective copyright notices and license terms.

## License

AGPL-3.0-or-later
