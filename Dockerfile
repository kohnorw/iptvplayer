FROM node:20-alpine

# ffmpeg-libs includes libx264 for H.264 transcoding (needed for Safari)
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install --production && npm cache clean --force

COPY app/ ./app/
COPY static/ ./static/

RUN mkdir -p /data && chown node:node /data

EXPOSE 8080
ENV PORT=8080 NODE_ENV=production DATA_DIR=/data

USER node

CMD ["node", "app/server.js"]
