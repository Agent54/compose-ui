# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
deno run npm:sv@0.14.1 create --template minimal --types ts --add prettier eslint tailwindcss="plugins:typography,forms" sveltekit-adapter="adapter:static" devtools-json mcp="ide:opencode" --install deno .
```

## Developing

Install dependencies and start a local development server with Deno:

```sh
deno install --allow-scripts=npm:esbuild
deno task dev

# or start the server and open the app in a new browser tab
deno task dev -- --open
```

## Docker Compose

Run the UI in Docker:

```sh
docker compose up
```

For Docker Compose Watch:

```sh
docker compose watch
```

## Building

To create the production static assets:

```sh
deno install --frozen --allow-scripts=npm:esbuild
deno task check
deno task build
```

The static adapter writes the complete site to `build/`, including `index.html` and
`_app/`. You can preview it with `deno task preview`. No Deno or Node server is needed
to serve the production files.

## CI and desktop release dependency

The [Static assets workflow](.github/workflows/static-assets.yml) runs on branch pushes,
pull requests, manual dispatch, and published GitHub releases (including prereleases).
It installs the frozen Deno lockfile, checks the app, builds it, and uploads a
`compose-ui-static` Actions artifact retained for 14 days.

Publishing a GitHub release builds the release's tagged commit and attaches:

- `compose-ui-static.tar.gz`
- `compose-ui-static.zip`
- `SHA256SUMS` (SHA-256 checksums for both archives)

Both archives contain the contents of `build/` directly at their root. They contain
only the static site, without source files, dependencies, or a server runtime, and
the same bundle can be used on all desktop platforms. Wait for the workflow to
finish before consuming a newly published release. Rerunning the release job
replaces assets with the same names. A tag push alone does not publish a release;
publish the release through GitHub or `gh release create` to trigger the upload.

In the desktop application's build, pin a release tag and download the bundle:

```sh
UI_VERSION=v0.1.0 # replace with a published release tag
gh release download "$UI_VERSION" --repo Agent54/compose-ui \
  --pattern 'compose-ui-static.*' --pattern SHA256SUMS --dir ui-download
cd ui-download
sha256sum --check SHA256SUMS # on macOS: shasum -a 256 --check SHA256SUMS
mkdir -p ../ui-assets
tar -xzf compose-ui-static.tar.gz -C ../ui-assets
```

Bundle `ui-assets/` into the desktop application and serve it through its local HTTP
server or webview asset protocol, with `index.html` as the entry point and correct
JavaScript/CSS MIME types. Keep the directory structure intact. Direct `file://`
loading is not the supported integration. The UI's configured Compose API server
must still be reachable from the desktop webview; the bundle does not include the
backend.

For an HTTP downloader, the tarball URL has the form
`https://github.com/Agent54/compose-ui/releases/download/<tag>/compose-ui-static.tar.gz`
(use the same path for `SHA256SUMS` or the ZIP). Authenticate downloads if the
repository is private.
