# Private plugins

This directory holds integrations that are developed privately and revealed on
announcement day. The public core in `apps/sdp-api` exposes a plugin seam; nothing
here is referenced from the public tree, so revealing a plugin is a plain `git mv`
with no edits to the integration itself.

## Layout

```
private/
  server.ts              private Node entrypoint — loads plugins and starts the app
  build-node.mjs         esbuild bundler for server.ts (aliases @/* to apps/sdp-api/src)
  tsconfig.json          maps @/* for type-checking files under private/
  plugins/
    <name>/
      index.ts           exports an SdpPlugin
      env.d.ts           declaration merging that extends Env with the plugin's vars
```

## The `SdpPlugin` contract

A plugin is any object matching the interface exported from the public core:

```ts
interface SdpPlugin {
  name: string;
  register(app: Hono<{ Bindings: Env }>): void;
}
```

`register` receives the `/v1` router and mounts routes on it. Names must be unique —
`createApp` throws on a duplicate name. Routes land under `/v1`, so a route registered
as `/example/hello` is served at `/v1/example/hello`.

## Declaring environment variables

A plugin declares its own env vars without touching shared files:

1. Extend `Env` via declaration merging in `env.d.ts`:

   ```ts
   declare module "@/types/env" {
     interface Env {
       EXAMPLE_SECRET?: string;
     }
   }
   ```

2. Register the key with the process-env fallback whitelist at load time:

   ```ts
   registerFallbackKeys("EXAMPLE_SECRET");
   ```

The value is then picked up from `process.env` by `withProcessEnvFallback` in the
Node runtime.

Two ordering rules make this work:

- `env.d.ts` only merges into `Env` when type-checked through `private/tsconfig.json`
  (its `@/*` mapping is what lets the augmentation resolve the original module). Check
  types with `tsc -p private/tsconfig.json`.
- `registerFallbackKeys` must run before the entrypoint reads env. Importing the plugin
  into the `plugins` array in `server.ts` guarantees this, since the import side effect
  runs before `withProcessEnvFallback`.

## Adding a plugin

1. Create `plugins/<name>/index.ts` exporting an `SdpPlugin`.
2. Add `env.d.ts` and `registerFallbackKeys(...)` if the plugin needs env vars.
3. Add the plugin to the `plugins` array in `server.ts`.

## Build and run

```sh
node private/build-node.mjs        # bundles to private/dist/server.mjs
node private/dist/server.mjs       # starts on :8787 (PORT to override)
```

`/health` responds without any bindings. Routes that hit the data layer (including
the global KV/rate-limit middleware on `/v1/*`) need Postgres + Redis running (use
the repo's docker-compose).

If a plugin pulls in a native addon that esbuild cannot bundle, add it to the
`external` array in `build-node.mjs`.

## Revealing a plugin

On announcement day, move the plugin into the public tree and wire it into the public
entrypoint:

```sh
git mv private/plugins/<name> apps/sdp-api/src/plugins/<name>
```

Then wire it into the public entrypoint and drop it from the private one: register the
plugin in the public app and remove it from the `plugins` array in `private/server.ts`.
The plugin code itself does not change — only its location and the entrypoint that
registers it.
