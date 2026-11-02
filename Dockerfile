FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv ca-certificates make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
EXPOSE 3000
CMD [ "node", "server.js" ]
