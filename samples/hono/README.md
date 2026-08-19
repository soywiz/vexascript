# Hono sample

This sample uses the unmodified published `hono` 4.13.3 package without
starting a network listener. It exercises a generic application environment,
typed middleware variables, route-parameter inference, overloaded route
registration, async handler composition, Web API response types, and Hono's
in-process `request` runtime.

The output is deterministic because the request is dispatched directly to the
application instance.
