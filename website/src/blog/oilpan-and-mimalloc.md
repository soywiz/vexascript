---
layout: blog-post.njk
title: Oilpan and mimalloc power VexaScript native memory
date: 2026-07-22
category: Native runtime
summary: Oilpan traces VexaScript object graphs while mimalloc accelerates ordinary native allocation; the two solve different layers of the generated runtime.
tags: blog
permalink: /blog/oilpan-and-mimalloc.html
---

VexaScript's native backend uses two memory systems for two different jobs. Oilpan, the C++ garbage collector used by Chromium, manages language-level object graphs. mimalloc services ordinary C and C++ allocation performed by runtime containers, support code, and linked libraries. Treating either allocator as a replacement for the other would blur ownership and make native semantics harder to reason about.

Oilpan entered the backend with the first C++ implementation in commit `a380895e` on July 16, 2026. mimalloc integration followed in commit `db813e29` on July 22, touching eight files with 130 insertions and 29 deletions. A controlled self-host benchmark using the exact same `-O1` object reduced wall time from 4.08 seconds with the system allocator to 3.28 seconds with mimalloc, a 19.6% reduction.

## **Oilpan implements language reachability**

VexaScript programs can create cycles, retain objects through fields, and expect reachable values to survive independently of C++ lexical scope. Reference counting is insufficient for those semantics: two objects that reference each other can remain permanently nonzero after the application drops every external reference.

The generated representation maps ownership concepts explicitly:

| VexaScript concept | Generated Oilpan representation | Purpose |
|---|---|---|
| Managed class instance | `cppgc::GarbageCollected<T>` | Places object lifetime under tracing |
| Managed object field | `cppgc::Member<T>` | Records an edge in the traced object graph |
| Runtime or stack-adjacent root | `cppgc::Persistent<T>` | Keeps a managed object reachable across native scopes |
| Class tracing method | `Trace(cppgc::Visitor*)` | Exposes member edges to the collector |
| Managed allocation | runtime Oilpan allocation helper | Allocates on the managed heap with the correct type |

This model lets the collector start from persistent roots, visit each object's `Trace` method, and reclaim an unreachable cycle as a unit. Generated code must not hide a managed edge in an ordinary raw pointer, because the collector cannot infer ownership from C++ memory.

The design rejected `std::shared_ptr` as the general object model. Shared ownership is convenient for acyclic resource graphs, but it changes language behavior in the presence of cycles. It also encourages turning long-lived runtime references into permanent roots, which makes collection correctness depend on manually breaking every graph.

## **Arrays must trace their contents, not only their shell**

An array object can be reachable while the managed objects stored inside it are reachable only through array slots. Tracing the array allocation without tracing those slots would allow live elements to be reclaimed. Conversely, rooting every element globally would preserve garbage forever.

The native runtime therefore represents arrays with an `ArrayObject` whose managed slots participate in tracing. This preserves three properties expected by the source language:

- object identity survives insertion and retrieval;
- cycles such as an array containing an object that refers back to the array are collectable;
- reachability follows the actual graph rather than C++ container lifetime.

Value storage and object storage remain distinguishable. A byte buffer used for FFI does not need every byte traced; an array of managed references does. Keeping that distinction in the type-directed emitter avoids paying collector barriers for raw data while preserving correctness for objects.

## **mimalloc handles the unmanaged allocation layer**

Even a traced runtime performs many allocations outside the managed heap: strings and temporary buffers, C++ standard-library containers, compiler data structures in a self-hosted executable, dynamic-loader bookkeeping, and allocations inside runtime support code. mimalloc targets this ordinary allocation traffic.

| Layer | Lifetime authority | Typical allocations |
|---|---|---|
| Managed VexaScript heap | Oilpan reachability | class instances, traced arrays, managed fields |
| Native support layer | C++ scope or explicit ownership | vectors, maps, strings, compiler temporaries |
| C ABI / third-party code | library contract | SDL resources, loader state, foreign buffers |
| Global `malloc`/`new` path in optimized builds | mimalloc implementation | eligible unmanaged allocations from the latter layers |

mimalloc does not trace `cppgc::Member` edges and cannot decide whether a VexaScript object is reachable. Oilpan does not automatically replace every allocation made by `std::vector` or a C library. The performance improvement came from optimizing the high-volume unmanaged side while leaving language lifetime semantics with Oilpan.

Sanitizer builds omit the allocator override. Address and undefined-behavior sanitizers need predictable interception of allocations, and debugging correctness is more valuable than reproducing release allocator performance in those configurations.

## **The benchmark controlled the compiler object**

Allocator comparisons are easy to invalidate by changing optimization flags or recompiling different generated source. The measured comparison linked the same `-O1` native compiler object against the two allocator configurations:

| Configuration | Native self-host wall time | Difference |
|---|---:|---:|
| System allocator | 4.08 s | baseline |
| mimalloc | 3.28 s | 0.80 s faster |
| Relative reduction | — | 19.6% |

This is a workload result, not a universal allocator claim. The workload is allocation-heavy: a generated compiler loads modules, constructs syntax and type-analysis data, builds strings and maps, and emits a large output file. A compute-bound program with few allocations should not be expected to gain the same percentage.

Later `-O3` native and Node comparisons are separate checkpoints because emitter changes, runtime optimizations, and the compiled graph changed. Keeping this allocator experiment isolated is what makes the 19.6% attribution defensible.

## **Vendoring the minimum viable source archive**

The initial repository carried the full mimalloc 3.4.3 source tarball at roughly 1.3 MB. A trimmed ZIP containing the material required by VexaScript is about 248 KB. The first attempt retained only `src/` and `include/`; it failed because mimalloc's CMake configuration also imports project metadata and helper modules.

The minimal archive includes:

| Path | Reason retained |
|---|---|
| `src/` | allocator implementation |
| `include/` | public and internal declarations used by the build |
| license files | redistribution terms must accompany vendored source |
| top-level CMake metadata | defines supported build targets and options |
| required three-file `cmake/` subset | includes `mimalloc-config-version.cmake` and `JoinPaths.cmake` dependencies |

The lesson is that “files compiled directly” is not the same set as “files required to configure the build.” The reduced archive was validated through the actual CMake integration rather than inferred from include statements alone.

Release builds cache the extracted dependency in an operating-system temporary cache. They link the allocator override without repeatedly unpacking or rebuilding it when the inputs are unchanged. The CMake route is portable across the macOS, Linux, and Windows native jobs instead of maintaining a platform-specific hand compilation command.

## **The boundary makes future optimization safer**

Using two memory systems increases the need for explicit boundary rules. Managed pointers held across asynchronous workers must remain rooted or be represented by copied stable data. FFI buffers need an ownership duration that covers the foreign call. C++ runtime containers must not smuggle untraced managed references. Sanitizers must be able to replace the release allocation path.

Those rules are easier to enforce because the roles are named:

- Oilpan answers which VexaScript objects are alive;
- mimalloc answers how ordinary native allocations are serviced efficiently;
- explicit native and FFI contracts answer who releases external resources.

The result is both semantic and measurable: cycles and object identity follow the source language, while an allocation-heavy self-host workload became 0.80 seconds faster under a controlled linker change. Neither fact requires claiming that one allocator solves every kind of memory.
