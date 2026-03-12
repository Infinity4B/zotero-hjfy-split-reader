# HJFY Split Reader

[![Zotero 8](https://img.shields.io/badge/Zotero-8-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org/)
[![CI](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/ci.yml)
[![Release](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/release.yml/badge.svg)](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/release.yml)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Fetch HJFY translations for arXiv papers and open the source PDF and translation side by side in Zotero 8.

[English](README.md) | [简体中文](doc/README-zhCN.md)

## Features

- Adds an item context-menu action: `Fetch HJFY translation and open in split view`
- Reuses an existing HJFY translation attachment when it already exists under the item
- Downloads and stores the translated PDF as a child attachment when HJFY already has a translated file
- Opens the source PDF and translated PDF in a single split-view reader tab
- Keeps Split-View Reader capabilities such as synchronized actions and pane swapping

## Current Scope

- Supported well: arXiv-backed papers where Zotero metadata contains an arXiv DOI, URL, or arXiv ID in `Extra`
- Partially supported: papers whose HJFY translation task already exists but still require polling
- Not yet automated: HJFY local-document upload flow, because `hjfy.top` currently requires login for uploads and task creation

If HJFY requires login to create a translation task, the plugin opens the corresponding HJFY page so you can continue there.

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
   - find an existing translation attachment if present
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
- `.scaffold/build/update-beta.json`

## Third-Party Notices

This project includes original work and derivative work based on the following open-source projects:

- [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template): project structure, build tooling, and plugin scaffold. Licensed under `AGPL-3.0-or-later`.
- [zerolfl/zotero-split-view-reader](https://github.com/zerolfl/zotero-split-view-reader): split-view reader implementation and related UI assets, adapted and modified for this project. Licensed under `AGPL-3.0-or-later`.
- [ANGJustinl/zotero-plugin-hjfy](https://github.com/ANGJustinl/zotero-plugin-hjfy): HJFY API integration approach and attachment import flow, adapted and modified for this project. Licensed under `AGPL-3.0-or-later`.

Please see [LICENSE](LICENSE) and the upstream repositories for their respective copyright notices and license terms.

## License

AGPL-3.0-or-later
