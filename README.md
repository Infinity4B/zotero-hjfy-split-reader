# HJFY Split Reader

[![Zotero 8](https://img.shields.io/badge/Zotero-8-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org/)
[![CI](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/ci.yml)
[![Release](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/release.yml/badge.svg)](https://github.com/Infinity4B/zotero-hjfy-split-reader/actions/workflows/release.yml)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

用于 Zotero 8 的插件：获取 arXiv 论文在 HJFY 上的译文 PDF，并把原文 PDF 与译文 PDF 以分屏方式并排打开。

[简体中文](README.md) | [English](doc/README-en.md)

## 功能

- 在条目右键菜单中增加“获取幻觉翻译并分屏打开”
- 如果同一条目下已经存在 HJFY 译文附件，则直接复用
- 如果 HJFY 已经有可下载的译文 PDF，则自动下载并保存为当前条目的子附件
- 自动将原文 PDF 和译文 PDF 以单标签页分屏方式打开
- 默认以右侧译文窗格为主窗格，左侧原文跟随译文滚动
- 保留分屏阅读器的交换左右窗格等能力

## 界面预览

### 右键菜单入口

<p align="center">
  <img src="doc/images/context-menu-zh.png" alt="条目右键菜单中的获取幻觉翻译并分屏打开入口" width="320" />
</p>

### 分屏阅读效果

<p align="center">
  <img src="doc/images/split-view-zh.png" alt="原文与译文在 Zotero 中分屏打开的效果" width="1100" />
</p>

## 当前支持范围

- 支持最好：条目里能解析出 arXiv DOI、arXiv URL，或 `Extra` 中含 arXiv ID 的论文
- 部分支持：HJFY 已有任务，但还需要轮询等待完成的情况
- 暂未自动化：HJFY 的“本地文档上传”流程，因为 `hjfy.top` 目前要求登录后才能上传和创建任务

如果 HJFY 对当前论文要求登录后才能创建翻译任务，插件会自动打开对应的 HJFY 页面，方便你继续操作。

## 安装

1. 打开 [Releases](https://github.com/Infinity4B/zotero-hjfy-split-reader/releases)
2. 下载最新的 `.xpi`
3. 在 Zotero 中打开 `工具` -> `插件`
4. 点击右上角齿轮 -> `Install Plugin From File...`
5. 选择下载的 `.xpi`

## 使用方式

1. 在 Zotero 中选中一篇论文条目，或这篇论文下的某个 PDF 附件
2. 右键点击 `获取幻觉翻译并分屏打开`
3. 插件会按下面顺序执行：
   - 先检查当前条目下是否已有译文附件
   - 若没有，则查询 `hjfy.top`
   - 如果拿到译文 PDF，则保存到当前条目附件中
   - 最后把原文 PDF 与译文 PDF 分屏打开

## 开发

```bash
npm install
npm start
```

常用命令：

```bash
npm run build
npm run lint:check
```

构建输出位于 `.scaffold/build/`，包括：

- `.scaffold/build/hjfy-split-reader.xpi`
- `.scaffold/build/update.json`

## 第三方来源与许可

本项目包含原创代码，也包含基于以下开源项目改写和衍生的部分：

- [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)：提供项目结构、构建工具链和插件脚手架。许可证为 `AGPL-3.0-or-later`。
- [zerolfl/zotero-split-view-reader](https://github.com/zerolfl/zotero-split-view-reader)：提供分屏阅读器核心实现及相关 UI 资源，本项目在其基础上做了适配与修改。许可证为 `AGPL-3.0-or-later`。
- [ANGJustinl/zotero-plugin-hjfy](https://github.com/ANGJustinl/zotero-plugin-hjfy)：提供 HJFY 接口接入思路与附件导入流程，本项目在其基础上做了适配与修改。许可证为 `AGPL-3.0-or-later`。

各上游项目的版权声明与许可证条款，请同时参见 [LICENSE](LICENSE) 与对应上游仓库。

## 许可证

AGPL-3.0-or-later
