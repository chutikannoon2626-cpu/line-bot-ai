#!/bin/bash
# install-rich-menu.sh
# วิธีใช้: LINE_CHANNEL_ACCESS_TOKEN=xxx bash install-rich-menu.sh
# ต้องมีไฟล์ rich-menu.json และ rich-menu.jpg อยู่ใน folder เดียวกัน

set -e

TOKEN="${LINE_CHANNEL_ACCESS_TOKEN:?กรุณาตั้ง LINE_CHANNEL_ACCESS_TOKEN ก่อน}"

echo "1/3 Creating rich menu..."
MENU_ID=$(curl -s -X POST https://api.line.me/v2/bot/richmenu \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @rich-menu.json | jq -r '.richMenuId')

if [ -z "$MENU_ID" ] || [ "$MENU_ID" = "null" ]; then
  echo "ERROR: ไม่สามารถสร้าง rich menu ได้ ตรวจสอบ Token และ rich-menu.json"
  exit 1
fi
echo "   Menu ID: $MENU_ID"

echo "2/3 Uploading image (rich-menu.jpg)..."
curl -s -X POST "https://api-data.line.me/v2/bot/richmenu/$MENU_ID/content" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/jpeg" \
  --data-binary @rich-menu.jpg

echo "3/3 Setting as default menu..."
curl -s -X POST "https://api.line.me/v2/bot/user/all/richmenu/$MENU_ID" \
  -H "Authorization: Bearer $TOKEN"

echo ""
echo "Done! Rich menu installed: $MENU_ID"
echo "ทดสอบใน LINE OA — ควรเห็นปุ่มด้านล่าง chat"
