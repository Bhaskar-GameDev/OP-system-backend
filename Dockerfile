# Patient Flow OS backend — demo image.
# Single stage (keeps dev deps so `prisma db seed` can run ts-node on start).
FROM node:20-slim

# OpenSSL is required by Prisma's query engine; ca-certificates for TLS.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching). Prisma schema is needed for the
# postinstall-free generate step below.
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# Generate the Prisma client, then build the Nest app.
RUN npx prisma generate
COPY . .
RUN npm run build

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# strip any CR (Windows checkout) so /bin/sh doesn't choke, then make executable
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
