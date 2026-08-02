---
layout: blog-post.njk
title: "What's included in VexaScript 0.9.0"
date: 2026-06-13
category: Release announcement
version: 0.9.0
summary: VexaScript 0.9.0 is the first public release, with the language, CLI, browser playground, Monaco embeds, and editor tools.
tags: blog
permalink: /blog/vexa-0.9.0.html
---

VexaScript 0.9.0 was released on June 13, 2026. It is the first public version
of the language and its main development tools.

## **Release contents**

| Area | Included in 0.9.0 |
| --- | --- |
| Language | TypeScript-based syntax with features inspired by Swift, Kotlin, and C# |
| CLI | Commands for compiling and running VexaScript |
| Browser | Interactive playground and embeddable Monaco editors |
| Editor tools | Language support for writing and exploring VexaScript code |
| Documentation | Syntax guide, CLI reference, and examples |

## **Language goals**

VexaScript keeps access to the TypeScript ecosystem while offering a shorter
syntax for common code. The language includes features such as `val`, `fun`,
primary constructors, `sync` functions, operator overloading, and class calls
without `new`.

Version 0.9.0 is a preview. It provides enough of the language and toolchain for
developers to try examples, report problems, and compare the design with normal
TypeScript projects.

## **Ways to try it**

The website provides a playground that runs in the browser. Monaco embeds can
place editable VexaScript examples in other pages. The CLI supports local
projects, and the editor integration provides language features while code is
being written.

The next releases focus on language fixes, TypeScript compatibility, editor
support, and larger real-world samples. Version 0.9.0 is the starting point for
that work.
