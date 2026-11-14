# Apify Node 22 image without a browser. Runtime memory is 256 MB.
FROM apify/actor-node:22-slim

ENV NODE_OPTIONS=--max-old-space-size=192

COPY --chown=myuser:myuser package.json package-lock.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -rf ~/.npm

COPY --chown=myuser:myuser . ./

USER myuser

CMD npm start --silent
