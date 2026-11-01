# GIA lookup service for a container host - headed Google Chrome inside a
# virtual screen (Xvfb), since GIA blocks headless. The host builds this itself;
# nothing is needed on our PCs. Keep the image tag on the same version as the
# `playwright` entry in package-lock.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npx playwright install --with-deps chrome
COPY server.mjs ./
# Reachable from outside the container - server.mjs then insists on GIA_SCRAPER_TOKEN.
ENV HOST=0.0.0.0
EXPOSE 10000
CMD ["xvfb-run", "--auto-servernum", "node", "server.mjs"]
