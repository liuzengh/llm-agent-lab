FROM node:22-alpine

RUN addgroup -S workflow && adduser -S workflow -G workflow
WORKDIR /sandbox
COPY runner.mjs /runner.mjs
USER workflow

ENTRYPOINT ["node", "/runner.mjs"]
