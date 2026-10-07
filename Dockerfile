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

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('EERONAUT_PORT','3340')+'/api/health',timeout=4).status==200 else 1)"

# Shell form so EERONAUT_PORT is honored. With host networking there is no port
# mapping to fall back on, so the listening port has to be settable here.
#
# No proxy headers. With `--forwarded-allow-ips '*'` uvicorn believed the
# `X-Forwarded-For` of whoever connected, so the address the sign-in lockout
# counts against was one the attacker chose: a different one per request and
# the lockout never fired. Every address is the connecting one.
CMD exec uvicorn eeronaut.main:app --host 0.0.0.0 --port "${EERONAUT_PORT:-3340}"
