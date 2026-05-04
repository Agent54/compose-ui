FROM denoland/deno:ubuntu

WORKDIR /app

COPY package.json .
COPY deno.json .
COPY deno.lock .
RUN deno install --frozen --allow-scripts=npm:esbuild

COPY . .

RUN deno task prepare
EXPOSE 5173

RUN chown -R deno:deno /app
USER deno

CMD ["task", "dev", "--host", "0.0.0.0"]
