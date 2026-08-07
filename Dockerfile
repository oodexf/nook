FROM node:24-alpine AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run check && npm run lint && npm run test && npm run build

FROM rust:1.97-bookworm AS rust-build
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/ crates/
COPY --from=frontend-build /build/frontend/dist frontend/dist/
RUN cargo test --workspace \
    && cargo build --locked --workspace --release

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 chat \
    && useradd --system --uid 10001 --gid chat --home-dir /nonexistent chat \
    && mkdir /data \
    && chown chat:chat /data

COPY --from=rust-build /build/target/release/chat-server /app/chat-server

USER 10001:10001
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["/app/chat-server", "healthcheck"]
ENTRYPOINT ["/app/chat-server"]

