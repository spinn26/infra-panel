FROM node:22-alpine
WORKDIR /app
COPY package.json server.js client.js ./
RUN mkdir -p /data && chown -R node:node /data /app
EXPOSE 8080
USER node
CMD ["node", "server.js"]
