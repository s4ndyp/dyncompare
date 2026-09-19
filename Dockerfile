# syntax=docker/dockerfile:1

ARG POCKETBASE_VERSION=0.40.4

FROM alpine:3.21
ARG POCKETBASE_VERSION

RUN apk add --no-cache ca-certificates curl unzip tini \
    && addgroup -S pocketbase \
    && adduser -S pocketbase -G pocketbase

WORKDIR /app

RUN curl -fsSL \
    "https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_linux_amd64.zip" \
    -o /tmp/pocketbase.zip \
    && unzip /tmp/pocketbase.zip -d /usr/local/bin/ \
    && chmod +x /usr/local/bin/pocketbase \
    && rm /tmp/pocketbase.zip

COPY pb_migrations/ ./pb_migrations/
COPY pb_public/ ./pb_public/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p pb_data \
    && chown -R pocketbase:pocketbase /app

USER pocketbase

EXPOSE 8090

VOLUME ["/app/pb_data"]

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
