# Use Debian-based Deno image for better ffmpeg compatibility
FROM denoland/deno:debian

# Install ffmpeg for video muxing and curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create videos directory
RUN mkdir -p /videos

# Expose default port
EXPOSE 3001

# Set default environment variables
ENV PORT=3001
ENV VIDEOS_PATH=/videos

# Health check using curl
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl --fail --silent http://localhost:${PORT}/health || exit 1

# Run the application (source is volume-mounted in compose)
CMD ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-run", "src/main.ts"]
