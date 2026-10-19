# syntax=docker/dockerfile:1.7

# ---- frontend -------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:26-alpine AS web
WORKDIR /src
COPY app/frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY app/frontend/ ./
# Vite writes into the backend package; redirect it to a clean location here.
RUN npx vite build --outDir /out --emptyOutDir

# ---- python deps ----------------------------------------------------------
# Built per target arch so grpcio and cryptography resolve the right wheels.
FROM python:3.14-slim-bookworm AS deps
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
WORKDIR /src
COPY app/backend/pyproject.toml app/backend/requirements.txt app/backend/hatch_build.py ./
COPY app/backend/eeronaut ./eeronaut
# Exactly the versions in requirements.txt, indirect ones included, so two
# builds of the same commit install the same thing. Eeronaut itself goes in
# after with --no-deps: its dependencies are already there, pinned.
RUN python -m venv /venv \
 && /venv/bin/pip install --upgrade pip wheel \
 && /venv/bin/pip install -r requirements.txt \
 && /venv/bin/pip install --no-deps .

# ---- runtime --------------------------------------------------------------
FROM python:3.14-slim-bookworm AS runtime
LABEL org.opencontainers.image.title="Eeronaut" \
      org.opencontainers.image.description="Web interface for eero mesh networks" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

# Runs as root, so it can write to a data folder Docker created on the host
# (which Docker makes as root) without anyone having to prepare it first.
RUN mkdir -p /data

COPY --from=deps /venv /venv
COPY --from=deps /src/eeronaut /app/eeronaut
COPY --from=web  /out /app/eeronaut/static
# Beside the package, not inside it: a theme is content, and the directory is
# where `eeronaut.core.themes` looks for the bundled ones.
COPY app/themes /app/themes

ENV PATH=/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    EERONAUT_DATA_DIR=/data \
    EERONAUT_PORT=3340

WORKDIR /app
VOLUME ["/data"]
EXPOSE 3340

# In Home Assistant the port comes from the app's options, which only
# Eeronaut's own code reads, so the check is a module rather than a line here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-m", "eeronaut.healthcheck"]

# The port is EERONAUT_PORT, read by Eeronaut itself. With host networking
# there is no port mapping to fall back on, so the listening port has to be
# settable, and it is, through the environment.
CMD ["python", "-m", "eeronaut"]

# ---- Home Assistant -------------------------------------------------------
# The same image runs as a Home Assistant app (homeassistant/eeronaut/),
# whose Supervisor reads these labels. Home Assistant calls arm64 aarch64, so
# each platform's image takes its own name from a stage of its own
# (TARGETARCH is BuildKit's; declaring it would blank it).
FROM runtime AS runtime-amd64
LABEL io.hass.arch="amd64"
FROM runtime AS runtime-arm64
LABEL io.hass.arch="aarch64"

FROM runtime-${TARGETARCH}
ARG EERONAUT_VERSION=dev
LABEL io.hass.type="app" \
      io.hass.name="Eeronaut" \
      io.hass.version="${EERONAUT_VERSION}"
