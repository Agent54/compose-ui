FROM denoland/deno:ubuntu

WORKDIR /app

COPY package.json .
COPY deno.json .
COPY deno.lock .
RUN deno install --allow-scripts=npm:esbuild,npm:workerd,npm:@cloudflare/workerd-linux-arm64,npm:@rolldown/binding-linux-arm64-gnu

COPY . .

RUN deno task prepare
EXPOSE 5173

RUN chown -R deno:deno /app
USER deno

CMD ["task", "dev", "--host", "0.0.0.0"]
