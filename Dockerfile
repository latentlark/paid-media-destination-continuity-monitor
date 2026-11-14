# Playwright image so optional browser mode can render JS and meta-refresh redirects.
# HTTP mode does not launch the browser. Default run memory stays 256 MB.
FROM apify/actor-node-playwright-chrome:22

ENV NODE_OPTIONS=--max-old-space-size=192
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

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
