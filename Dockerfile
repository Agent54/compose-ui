# syntax=docker/dockerfile:1.7

FROM denoland/deno:ubuntu

WORKDIR /app
ENV DENO_NO_UPDATE_CHECK=1

RUN chown deno:deno /app
USER deno

COPY --chown=deno:deno package.json deno.json deno.lock ./
RUN --mount=type=cache,target=/deno-dir,uid=1993,gid=1993 \
	deno install --frozen --allow-scripts=npm:esbuild

COPY --chown=deno:deno . .

RUN --mount=type=cache,target=/deno-dir,uid=1993,gid=1993 \
	deno task prepare
EXPOSE 5173

CMD ["task", "dev", "--host", "0.0.0.0"]
