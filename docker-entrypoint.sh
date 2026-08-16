#!/bin/sh
set -e

# Load .env if present
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

# If DATABASE_URL is not set, but individual DATABASE_* variables are provided, assemble DATABASE_URL
if [ -z "$DATABASE_URL" ] && [ -n "$DATABASE_HOST" ]; then
  DB_PORT="${DATABASE_PORT:-5432}"
  export DATABASE_URL="postgresql://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DB_PORT}/${DATABASE_NAME}?sslmode=require"
  echo "[Startup] Constructed DATABASE_URL from DATABASE_HOST, DATABASE_USER, etc."
fi

# Trim any leading/trailing quotes that may have been accidentally copied in environment variables
if [ -n "$DATABASE_URL" ]; then
  DATABASE_URL=$(echo "$DATABASE_URL" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  export DATABASE_URL
fi

if [ -z "$DATABASE_URL" ]; then
  echo "================================================================================"
  echo "[ERROR] DATABASE_URL is not set!"
  echo "Please set DATABASE_URL or DATABASE_HOST in your Koyeb Environment Variables."
  echo "================================================================================"
  exit 1
fi

echo "[Startup] Syncing database schema with Prisma..."
npx prisma db push --skip-generate

echo "[Startup] Starting NestJS application..."
exec node dist/main
