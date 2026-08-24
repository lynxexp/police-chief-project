#!/bin/sh

cd /app

if [ -z "${DISCORD_BOT_TOKEN}" ]; then
    echo "please set DISCORD_BOT_TOKEN"
    exit 1
fi

echo "${DISCORD_BOT_TOKEN}" > bot_token.txt

python main.py
