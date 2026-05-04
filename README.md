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

To create a production version of your app:

```sh
deno task build
```

You can preview the production build with `deno task preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
