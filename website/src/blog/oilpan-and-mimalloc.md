---
layout: blog-post.njk
title: Why VexaScript uses Oilpan and mimalloc
date: 2026-07-22
category: Native runtime
summary: Oilpan manages VexaScript objects and cycles, while mimalloc speeds up ordinary C and C++ allocations in native builds.
tags: blog
permalink: /blog/oilpan-and-mimalloc.html
---

The native VexaScript runtime uses Oilpan and mimalloc for different kinds of
memory. Oilpan decides when VexaScript objects can be collected. mimalloc
handles ordinary allocations made by C++ containers and runtime code.

Oilpan arrived with the first C++ backend in commit `a380895e`. mimalloc was
added in commit `db813e29` on July 22, 2026.

## **Oilpan manages VexaScript objects**

VexaScript objects can form cycles. Reference counting cannot remove a cycle
when the objects still point to each other but the program can no longer reach
them.

| Source concept | Oilpan representation |
| --- | --- |
| Class instance | `cppgc::GarbageCollected<T>` |
| Object field | `cppgc::Member<T>` |
| Long-lived root | `cppgc::Persistent<T>` |
| Managed allocation | Runtime Oilpan allocation helper |

Generated classes report their managed fields to Oilpan. The collector starts
from known roots, follows those fields, and removes unreachable objects,
including cycles.

The backend did not use `std::shared_ptr` for all objects because cycles would
leak unless the compiler also selected weak references throughout the program.

## **Managed arrays**

An array may be the only object that points to one of its elements. The
collector must therefore trace object references stored in array slots.

The native runtime uses `ArrayObject`. Arrays of managed objects expose their
elements to Oilpan. Raw buffers and primitive arrays do not trace every value.
This keeps object references safe without adding garbage-collector work to
plain byte data.

## **mimalloc handles ordinary C++ allocation**

Many native allocations are outside the VexaScript object heap.

| Memory | Owner |
| --- | --- |
| VexaScript classes and managed arrays | Oilpan |
| C++ vectors, maps, strings, and compiler data | C++ and mimalloc |
| SDL objects and foreign buffers | The external library contract |

mimalloc cannot trace VexaScript objects. Oilpan does not replace every
allocation made by the C++ standard library. Using both keeps these jobs
separate.

Sanitizer builds do not use the mimalloc override. AddressSanitizer and
UndefinedBehaviorSanitizer need to intercept allocations themselves.

## **Measured allocator result**

The comparison linked the same generated `-O1` compiler object once with the
system allocator and once with mimalloc.

| Allocator | Self-host time |
| --- | ---: |
| System allocator | 4.08 s |
| mimalloc 3.4.3 | 3.28 s |
| Reduction | 19.6% |

This compiler workload creates many strings, maps, syntax objects, and output
buffers. Programs that allocate less memory should not be expected to see the
same improvement.

## **Packaging mimalloc**

The full mimalloc archive was about 1.3 MB. A smaller archive reduced it to
about 248 KB. The first small archive kept only `src/` and `include/`, but the
build failed because CMake also needed project metadata and helper files.

The final archive keeps the source, headers, licenses, top-level CMake files,
and the required CMake helpers. The native build caches the extracted files and
compiled allocator.

The memory rule is simple: Oilpan tracks VexaScript objects, mimalloc services
ordinary native allocation, and external APIs define the lifetime of their own
resources. Managed pointers sent to workers or FFI code must still be rooted or
copied safely.
