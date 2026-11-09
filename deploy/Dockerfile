FROM node:22-trixie-slim
# The JDK runs target builds. The AI CLIs are installed as published.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-21-jdk-headless git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code @openai/codex \
 && mkdir -p /data /workspace /gradle && chown node:node /data /workspace /gradle
WORKDIR /opt/figma-intent
COPY . .
USER node
EXPOSE 4318
CMD ["node", "--max-old-space-size=128", "--max-semi-space-size=8", "server.mjs"]
