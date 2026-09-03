# syntax=docker/dockerfile:1
#
# Imagen única para api y worker (mismo dist/, docker-compose.prod.yml decide el
# comando de cada servicio): sección 10 de la arquitectura.

# =====================================================================
# deps — instala dependencias con --frozen-lockfile. Necesita toolchain de
# compilación nativa (argon2 no trae binario prebuilt para musl/alpine).
# =====================================================================
FROM node:20-alpine AS deps
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /app

# prisma/ se copia ANTES del install: el postinstall del proyecto corre
# `prisma generate` y necesita el schema. No se usa --ignore-scripts para
# saltearlo porque eso también saltearía la compilación nativa de argon2.
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# =====================================================================
# build — genera el cliente de Prisma y compila TypeScript (dist/main.js
# y dist/worker.js: nest build compila todo src/ vía tsconfig.build.json,
# no solo lo alcanzable desde un único entry point).
# =====================================================================
FROM node:20-alpine AS build
# node:20-alpine no trae openssl instalado: sin él, el motor de Prisma no puede
# detectar la versión de libssl y el binaryTarget generado no funciona en runtime
# (falla con "Could not parse schema engine response" al ejecutar, no al generar
# — el error solo aparece recién al correr migrate deploy/el cliente real).
RUN apk add --no-cache openssl
RUN corepack enable
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src

RUN pnpm exec prisma generate
RUN pnpm run build
RUN pnpm prune --prod

# =====================================================================
# runtime — imagen mínima, sin toolchain de compilación, usuario no-root
# uid 1000 (sección 6, regla 5: el volumen de storage se monta con este uid).
# node:20-alpine ya trae un usuario "node" con uid/gid 1000 — se reutiliza
# en vez de crear uno nuevo (colisionaría con ese gid).
# =====================================================================
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

# El comando real lo fija cada servicio en docker-compose.prod.yml
# (api corre migrate deploy antes; worker arranca directo).
CMD ["node", "dist/main.js"]
