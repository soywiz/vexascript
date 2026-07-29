# Serve watcher fallback

The CLI `serve` reload test exposed an intermittent race: a source file can be
written after the HTTP and SSE connections are ready but before the platform
file watcher has begun delivering events. The rebuild is then missed, leaving
the browser session waiting for a reload event and, in CI, potentially keeping
the test runner alive during cleanup.

`startServeSession` still uses filesystem events as its primary mechanism. It
also now periodically compares the async version of every watched file with
the version recorded by the existing watcher synchronisation path. A mismatch
is routed through the same debounced rebuild queue, so watcher events and the
fallback cannot diverge into separate rebuild implementations.

The CLI integration test already writes the entrypoint immediately after
opening the SSE stream. Keeping that timing is intentional: it exercises the
race rather than masking it with a delay.
