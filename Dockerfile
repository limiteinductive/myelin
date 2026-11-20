# Myelin in one container: the Node server, the built web app, Caddy for HTTPS and the Python
# sandbox. `myelin deploy <host>` sends this directory to the host over SSH and builds it there.
# deploy/entrypoint.sh cuts the sandbox off from the network and from the learners' files.

FROM node:26.13.0-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/cli/package.json packages/cli/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY design design
COPY prompts prompts
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM caddy:2.11.7 AS caddy

FROM node:26.13.0-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv iptables ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# What code on a page can import. PyTorch is the CPU build.
RUN python3 -m venv /opt/sandbox \
 && /opt/sandbox/bin/pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.15.0 \
 && /opt/sandbox/bin/pip install --no-cache-dir numpy==2.5.4 scipy==1.18.1 sympy==1.14.0 matplotlib==3.11.2
# Runs go to this user. Nothing else runs as it.
RUN groupadd --system --gid 10001 sandbox \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sandbox
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=build /app /app
COPY deploy/Caddyfile deploy/entrypoint.sh /app/deploy/
RUN chmod 755 /app/deploy/entrypoint.sh /app/packages/cli/dist/main.js \
 && ln -s /app/packages/cli/dist/main.js /usr/local/bin/myelin
ENV NODE_ENV=production \
    HOME=/tmp/home \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/tmp/config \
    MYELIN_DATA=/data/myelin \
    MYELIN_PYTHON=/opt/sandbox/bin/python \
    MYELIN_SANDBOX_UID=10001 \
    MYELIN_SANDBOX_GID=10001 \
    MYELIN_RUN_MEMORY_MB=2048
VOLUME /data
EXPOSE 80 443 443/udp
LABEL app=myelin
ENTRYPOINT ["/app/deploy/entrypoint.sh"]
