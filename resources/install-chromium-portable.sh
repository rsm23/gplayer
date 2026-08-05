#!/bin/bash

# Ensure script is run as root/sudo
if [ "$EUID" -ne 0 ]; then
  echo "[-] ERROR: Please run this script as root or with sudo!"
  exit 1
fi

echo "[+] 1. Updating package repository..."
apt update -y

echo "[+] 2. Installing supporting libraries required by Headless Chromium..."
# Installing all graphics dependencies, fonts, sandbox, and memory allocation libraries
apt install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
               libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
               libxrandr2 libgbm1 libasound2 libcairo2 libpango-1.0-0 \
               wget tar xz-utils

echo "[+] 3. Downloading Chromium Portable (Ungoogled v150)..."
URL="https://github.com/macchrome/linchrome/releases/download/v150.7871.92-M150.0.7871.92-r1639810-portable-ungoogled-Lin64/ungoogled-chromium_150.0.7871.92_1.vaapi_linux.tar.xz"
FILE_NAME="ungoogled-chromium_150.0.7871.92_1.vaapi_linux.tar.xz"
DIR_NAME="chromium_150.0.7871.92_1.vaapi_linux"

# Download package if it doesn't exist
if [ ! -f "$FILE_NAME" ]; then
    wget -O "$FILE_NAME" "$URL"
else
    echo "[*] Archive file already downloaded, skipping download."
fi

echo "[+] 4. Extracting archive file..."
tar -xvf "$FILE_NAME"

echo "[+] 5. Moving files to /opt/chromium-portable..."
# Clean old folder if it exists to prevent conflict
if [ -d "/opt/chromium-portable" ]; then
    rm -rf /opt/chromium-portable
fi
mv "$DIR_NAME" /opt/chromium-portable

echo "[+] 6. Configuring permissions to allow execution by 'www'/'www-data' user..."
chown -R root:root /opt/chromium-portable
chmod -R 755 /opt/chromium-portable

echo "[+] 7. Creating Symbolic Link at /usr/bin/chromium..."
# Remove old symlink if it exists
if [ -L "/usr/bin/chromium" ] || [ -f "/usr/bin/chromium" ]; then
    rm -f /usr/bin/chromium
fi
ln -s /opt/chromium-portable/chrome /usr/bin/chromium

echo "[+] 8. Cleaning up downloaded file (.tar.xz)..."
rm -f "$FILE_NAME"

echo "--------------------------------------------------------"
echo "[+] INSTALLATION PROCESS COMPLETED!"
echo "--------------------------------------------------------"
echo "[*] Testing Chromium version:"
chromium --version

echo ""
echo "[*] Testing headless rendering (Target: example.com):"
chromium --headless=new --disable-gpu --no-sandbox --dump-dom https://example.com | head -n 10
echo "--------------------------------------------------------"