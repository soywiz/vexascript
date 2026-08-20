# Hono sample

This sample uses the unmodified published `hono` 4.13.3 package. `main.vx`
keeps the automated check deterministic by dispatching a request directly to
the application instance. It exercises a generic application environment,
typed middleware variables, route-parameter inference, overloaded route
registration, async handler composition, Web API response types, and Hono's
in-process `request` runtime.

`server.vx` is a real Node.js server powered by `@hono/node-server`. It opens a
TCP port, applies middleware, renders HTML, extracts a route parameter, parses a
typed JSON request body, and returns JSON responses:

```sh
pnpm cli vexa samples/hono/server.vx
curl http://localhost:3000/api/users/7
curl -X POST -H 'content-type: application/json' \
  -d '{"values":[3,5,8]}' http://localhost:3000/api/sum
```
