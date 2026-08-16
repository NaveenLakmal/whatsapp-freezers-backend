#!/bin/sh
set -e

# Load .env if present
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

# Strip surrounding quotes if present
if [ -n "$DATABASE_URL" ]; then
  DATABASE_URL=$(echo "$DATABASE_URL" | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
fi

# If DATABASE_URL has unexpanded shell variables (e.g. literal ${DATABASE_USER}), clear it to trigger reconstruction
case "$DATABASE_URL" in
  *\$* )
    echo "[Startup] DATABASE_URL contains unexpanded template variables (\$). Rebuilding..."
    DATABASE_URL=""
    ;;
esac

# If DATABASE_URL does not start with postgresql:// or postgres://, attempt reconstruction from individual vars
case "$DATABASE_URL" in
  postgresql://*|postgres://*)
    # Valid protocol
    ;;
  *)
    if [ -n "$DATABASE_HOST" ]; then
      DB_PORT="${DATABASE_PORT:-5432}"
      DATABASE_URL="postgresql://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DB_PORT}/${DATABASE_NAME}?sslmode=require"
      echo "[Startup] Reconstructed DATABASE_URL from DATABASE_HOST, DATABASE_USER, DATABASE_PASSWORD, DATABASE_NAME."
    fi
    ;;
esac

export DATABASE_URL

# Validate protocol before calling Prisma
case "$DATABASE_URL" in
  postgresql://*|postgres://*)
    # Mask password when logging for security
    SAFE_URL=$(echo "$DATABASE_URL" | sed -E 's/:([^@:]+)@/:****@/')
    echo "[Startup] Using database URL: $SAFE_URL"
    ;;
  *)
    echo "================================================================================"
    echo "[ERROR] Invalid or missing DATABASE_URL!"
    echo "Current DATABASE_URL: '$DATABASE_URL'"
    echo "DATABASE_URL must start with 'postgresql://' or 'postgres://'."
    echo "Please set DATABASE_URL in your Koyeb Environment Variables to:"
    echo "postgresql://koyeb-adm:npg_UjuTIzriE58R@ep-crimson-shadow-a1mzygk8.ap-southeast-1.pg.koyeb.app:5432/whatappDBV2?sslmode=require"
    echo "================================================================================"
    exit 1
    ;;
esac

echo "[Startup] Syncing database schema with Prisma..."
npx prisma db push --skip-generate

echo "[Startup] Starting NestJS application..."
exec node dist/main
