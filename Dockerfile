# ---- Build stage ----
FROM node:20-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# Copy everything first so tsc has full context
COPY package*.json tsconfig*.json ./
COPY prisma ./prisma/

RUN npm install
RUN npx prisma generate

COPY . .

# Compile TypeScript
RUN npm run build || npx tsc --skipLibCheck

# ---- Production stage ----
FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl curl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY prisma ./prisma/
RUN npx prisma generate

COPY --from=builder /app/dist ./dist

EXPOSE 3000

# DATABASE_URL must be provided at runtime (Railway injects your Postgres URL).
CMD ["sh", "-c", "npx prisma db push --accept-data-loss --skip-generate && node dist/main.js"]
