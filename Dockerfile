FROM node:22-alpine

WORKDIR /app

# Install OpenSSL for Prisma engine compatibility on Alpine
RUN apk add --no-cache openssl

# Copy dependency definitions
COPY package*.json ./

# Install dependencies using clean install
RUN npm ci

# Copy Prisma schema and generate Prisma Client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source code and build production assets
COPY . .
RUN npm run build

# Expose default HTTP port
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Start production server
CMD ["npm", "run", "start:prod"]
