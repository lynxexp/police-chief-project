FROM python:3.12.12-slim-bookworm
# Placeholder maintainer/source labels - update these once this project has a permanent home.
LABEL maintainer="police-chief-bot"
LABEL org.opencontainers.image.description="Police Chief Discord bot"

COPY docker/bootstrap.sh /bootstrap.sh

RUN set -x
RUN apt-get update && apt-get install --no-install-recommends -y curl ca-certificates
RUN pip install --upgrade pip
RUN mkdir -p /app

# This project ships its own source - copy the repo into the image directly
# rather than fetching an installer over the network. Build from the
# repository root, e.g.: docker build -t police-chief-bot:latest -f docker/Dockerfile .
COPY . /app
RUN cd /app && pip install --no-cache-dir -r requirements.txt

RUN chmod +x /bootstrap.sh
RUN apt-get -y autoremove && apt-get -y autoclean && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1

WORKDIR /app
ENTRYPOINT ["/bin/sh", "/bootstrap.sh"]
