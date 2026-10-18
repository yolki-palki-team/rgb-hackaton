ARG TARGETARCH
# The fork and release match MutinyWallet/mutiny-net's published Dockerfile.
FROM debian:bullseye-slim@sha256:e5b6442dd2e9684cf5e87d8338b5968f3b348636fc0be6d7850a381e3731a2bd AS download-arm64
ADD --checksum=sha256:c18705e9e98202e095e13bbc5546b5f34fbb4df9bf8bc34ef4553f6d2d1d68bc https://github.com/benthecarman/bitcoin/releases/download/mutinynet-inq-template-hash/bitcoin-2fda7bfc027e-aarch64-linux-gnu.tar.gz /tmp/bitcoin.tar.gz

FROM debian:bullseye-slim@sha256:e5b6442dd2e9684cf5e87d8338b5968f3b348636fc0be6d7850a381e3731a2bd AS download-amd64
ADD --checksum=sha256:c76b58a078e3e5fcc4597f50d9f9d15da8d11a5d8cf0831ab62970329bfb6115 https://github.com/benthecarman/bitcoin/releases/download/mutinynet-inq-template-hash/bitcoin-2fda7bfc027e-x86_64-linux-gnu.tar.gz /tmp/bitcoin.tar.gz

FROM download-${TARGETARCH} AS download
RUN mkdir /out \
    && tar -xzf /tmp/bitcoin.tar.gz --strip-components=2 -C /out \
      bitcoin-2fda7bfc027e/bin/bitcoind bitcoin-2fda7bfc027e/bin/bitcoin-cli

FROM debian:bullseye-slim@sha256:e5b6442dd2e9684cf5e87d8338b5968f3b348636fc0be6d7850a381e3731a2bd
COPY --from=download /out/ /usr/local/bin/
RUN mkdir /data && chmod 700 /data
ENTRYPOINT ["bitcoind", "-datadir=/data", "-conf=/config/bitcoin.conf"]
