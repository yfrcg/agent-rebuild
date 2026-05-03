FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    git \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Build with:
# docker build -t agentrebuild-sandbox:latest -f packages/sandbox/Dockerfile .
