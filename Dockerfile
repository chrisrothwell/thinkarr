# Stage 1: Install dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
# Rebuild better-sqlite3 for Alpine
RUN npm rebuild better-sqlite3

# Stage 2: Build the application
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Stage 3: Production runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV CONFIG_DIR=/config
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN apk add --no-cache shadow su-exec && \
    mkdir -p /config && \
    chown node:node /config

# Copy standalone build
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
VOLUME /config

ENTRYPOINT ["/entrypoint.sh"]
