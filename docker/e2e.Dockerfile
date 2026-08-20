# syntax=docker/dockerfile:1
ARG TB_VERSION=140.14.0esr

FROM ubuntu:24.04

ARG TB_VERSION
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils \
        xvfb x11-utils dbus-x11 \
        libgtk-3-0 libasound2t64 libdbus-glib-1-2 libx11-xcb1 libxt6 libpci3 \
        python3 python3-pip python3-venv \
        jq zip unzip make git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://ftp.mozilla.org/pub/thunderbird/releases/${TB_VERSION}/linux-x86_64/en-US/thunderbird-${TB_VERSION}.tar.xz" \
        -o /tmp/tb.tar.xz \
    && mkdir -p /opt \
    && tar -xJf /tmp/tb.tar.xz -C /opt \
    && rm /tmp/tb.tar.xz \
    && ln -s /opt/thunderbird/thunderbird /usr/local/bin/thunderbird

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir marionette-driver==3.7.1 pytest==8.3.3

ENV PATH="/opt/venv/bin:${PATH}" \
    DISPLAY=:99 \
    MOZ_HEADLESS=1

WORKDIR /hunote
CMD ["bash", "-c", "Xvfb :99 -screen 0 1280x1024x24 & sleep 1 && pytest tests/e2e/ -v"]
