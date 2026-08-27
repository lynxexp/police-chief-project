# Tiny, single-purpose image: one file, one dependency (dockerode), no
# shell tools beyond what node:slim already has. Deliberately built
# locally rather than published to a registry -- this holds the Docker
# socket, and pulling an image for that from anywhere (even our own
# registry) is one more thing that would need to be trusted; building it
# from source you can read, right here, keeps that trust chain as short
# as possible.

FROM node:22-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV NODE_ENV=production
EXPOSE 8090

CMD ["node", "server.js"]
