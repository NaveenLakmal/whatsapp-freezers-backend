FROM node:22-alpine

WORKDIR /app

# Install OpenSSL for Prisma engine compatibility on Alpine
RUN apk add --no-cache openssl

# Copy dependency definitions and Prisma schema
# (prisma directory is required during `npm ci` because package.json runs `postinstall: prisma generate`)
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies using clean install
RUN npm ci

# Explicitly ensure Prisma Client is generated
RUN npx prisma generate

# Copy source code and build production assets
COPY . .
RUN chmod +x ./docker-entrypoint.sh
RUN npm run build

# Expose default HTTP port
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Start production server
CMD ["npm", "run", "start:prod"]
