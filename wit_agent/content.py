"""Local content service client and evidence-bound content replies."""

import os
import re

import httpx


def normalize_link_record(raw: dict) -> dict | None:
    """Adapt a Link Bridge ContentRecord to the shopping UI's content record."""
    if not isinstance(raw, dict) or not isinstance(raw.get("source"), dict):
        return None
    url = raw["source"].get("url")
    if not isinstance(url, str) or not url.startswith(("https://", "http://")):
        return None
    images = [value for value in raw.get("images", []) if isinstance(value, str) and value.startswith(("https://", "http://"))][:12]
    cover = raw.get("cover")
    if isinstance(cover, str) and cover.startswith(("https://", "http://")) and cover not in images:
        images.insert(0, cover)
    media = [{"id": f"image-{i}", "type": "image", "url": value, "status": "available"} for i, value in enumerate(images, 1)]
    video = raw.get("video")
    if isinstance(video, str) and video.startswith(("https://", "http://")):
        media.append({"id": "video-1", "type": "video", "url": video, "status": "available"})
    body = str(raw.get("body") or raw.get("description") or "")[:6000]
    presentation = raw.get("presentation") if isinstance(raw.get("presentation"), dict) else None
    return {
        "id": str(raw.get("id") or url)[:128], "kind": "product_link" if raw.get("linkCategory") == "product" else "content", "source": {"url": url, "platform": str(raw["source"].get("platform") or "网页")},
        "title": str(raw.get("title") or "链接内容")[:240], "body": body,
        "contentType": str(raw.get("contentType") or "unknown"), "media": media,
        "coverMediaId": media[0]["id"] if images else None,
        "embed": str(raw.get("embed") or ""), "status": str(raw.get("status") or "unavailable"),
        "issue": str(raw.get("issue") or ""), "readBy": raw.get("readBy") if isinstance(raw.get("readBy"), list) else [],
        "presentation": presentation if presentation and presentation.get("protocol") == "v0.9.1" and isinstance(presentation.get("messages"), list) else None,
        "retrieval": {"textAvailable": bool(body), "status": str(raw.get("status") or "unavailable")},
    }


async def discover_related_content(task: dict) -> dict:
    url = os.getenv("WIT_CONTENT_URL", "http://127.0.0.1:3000/internal/content/discover")
    try:
        async with httpx.AsyncClient(timeout=145.0) as client:
            response = await client.post(url, json=task)
            response.raise_for_status()
            payload = response.json()
            if payload.get("ok") and isinstance(payload.get("records"), list):
                return payload
    except (httpx.HTTPError, ValueError, TypeError):
        pass
    return {"records": [], "status": "unavailable", "diagnostics": {"reason": "content_service_unavailable"}}


def content_reply(record: dict, message: str) -> str:
    title = record.get("title") or "这篇帖子"
    body = str(record.get("body") or "").strip()
    if "图" in message or "视频" in message:
        return "目前只取得媒体链接，没有进行图像或视频内容识别，不能确认画面展示了什么。可以打开原帖查看。"
    if not body:
        return f"目前只读到《{title}》的标题，正文尚未取得，不能据此判断作者为什么推荐或具体说了什么。"
    sentences = [part.strip() for part in re.split(r"[。！？\n]", body) if part.strip()]
    relevant = [part for part in sentences if any(term in part for term in ("推荐", "使用", "体验", "觉得", "优点", "缺点", "适合"))]
    excerpt = (relevant or sentences)[0][:180] if sentences else body[:180]
    return f"《{title}》正文中提到：“{excerpt}”。这是来源页面的内容，具体是否适合你还要结合商品资料判断。"
