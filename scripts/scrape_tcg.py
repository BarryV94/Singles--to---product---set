#!/usr/bin/env python3
"""
scripts/scrape_tcg.py
Scraper requests + BeautifulSoup.

Usage:
  python scripts/scrape_tcg.py BASE_PATTERN START_PAGE MAX_PAGES OUT_DIR

Example:
  python scripts/scrape_tcg.py "https://www.tcgplayer.com/search/pokemon/product?productLineName=pokemon&page={page}&view=grid&ProductTypeName=Sealed+Products" 1 200 tcg-sealed-price-guide
"""
import sys
import time
import json
import random
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from urllib.parse import urljoin
import requests
from bs4 import BeautifulSoup
import os

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; PriceGuideBot/1.0; +https://example.com/bot)",
    "Accept-Language": "en-US,en;q=0.9"
}

def fetch_page(url, session):
    resp = session.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return BeautifulSoup(resp.text, "lxml")

def extract_from_hfb(el, base_url, page_number, pos):
    """
    Extract one product-like item from a container with class 'search-layout-hfb'.
    Returns dict or None.
    """
    try:
        # Prefer an internal anchor linking to product
        a = el.select_one("a[href*='/product/']")
        href = a.get("href") if a else None
        product_url = urljoin(base_url, href.split("?")[0]) if href else None

        # Title: anchor text, or heading inside
        title = None
        if a:
            title = a.get_text(strip=True)
        if not title:
            t = el.select_one(".product-title, .title, h2, h3")
            title = t.get_text(strip=True) if t else None

        # Image
        img = el.select_one("img")
        img_url = None
        if img:
            img_url = img.get("data-src") or img.get("src") or img.get("data-original")
            if img_url:
                img_url = urljoin(base_url, img_url)

        # Price: try several selectors commonly used
        price_el = el.select_one(".price, .product-price, .search-result__price, .card-price, .hfb-price, .price-amount")
        price_text = price_el.get_text(strip=True) if price_el else None

        # fallback: try to find price near the anchor
        if not price_text and a:
            parent = a.parent
            if parent:
                cand = parent.select_one(".price, .product-price, .search-result__price, .card-price, .hfb-price")
                if cand:
                    price_text = cand.get_text(strip=True)

        return {
            "title": title or None,
            "product_url": product_url,
            "image": img_url,
            "price_text": price_text,
            "page": page_number,
            "position_on_page": pos,
            "source": "search-layout-hfb",
            "scraped_at": datetime.now(timezone.utc).astimezone(ZoneInfo("Europe/Warsaw")).isoformat()
        }
    except Exception:
        return None

def extract_from_anchor(a, base_url, page_number, pos):
    """Extract product data from a generic anchor pointing to /product/"""
    try:
        href = a.get("href")
        if not href:
            return None
        product_url = urljoin(base_url, href.split("?")[0])
        title = a.get_text(strip=True) or a.get("title") or None
        img = a.select_one("img")
        img_url = None
        if img:
            img_url = img.get("data-src") or img.get("src") or img.get("data-original")
            if img_url:
                img_url = urljoin(base_url, img_url)
        price_text = None
        price_el = a.select_one(".price, .product-price, .search-result__price, .card-price")
        if price_el:
            price_text = price_el.get_text(strip=True)
        # fallback: parent search
        if not price_text:
            parent = a.parent
            if parent:
                cand = parent.select_one(".price, .product-price, .search-result__price, .card-price")
                if cand:
                    price_text = cand.get_text(strip=True)
        return {
            "title": title or None,
            "product_url": product_url,
            "image": img_url,
            "price_text": price_text,
            "page": page_number,
            "position_on_page": pos,
            "source": "anchor",
            "scraped_at": datetime.now(timezone.utc).astimezone(ZoneInfo("Europe/Warsaw")).isoformat()
        }
    except Exception:
        return None

def parse_products(soup, base_url, page_number):
    products = []
    seen = set()
    pos = 0

    # 1) First, extract explicit 'search-layout-hfb' blocks (user requested)
    hfb_blocks = soup.select(".search-layout-hfb")
    for block in hfb_blocks:
        # sometimes the block contains multiple item cards, try to find item containers inside it
        item_containers = block.select(".product-card, .result-item, .search-result__item, .card, .hfb-item")
        if not item_containers:
            # if none found, treat the block itself as an item
            item_containers = [block]
        for item in item_containers:
            pos += 1
            p = extract_from_hfb(item, base_url, page_number, pos)
            if p and (p.get("product_url") or p.get("title")):
                key = p.get("product_url") or p.get("title")
                if key not in seen:
                    seen.add(key)
                    products.append(p)

    # 2) Also fallback to generic anchors (ensures coverage)
    anchors = soup.select("a[href*='/product/']")
    for a in anchors:
        pos += 1
        p = extract_from_anchor(a, base_url, page_number, pos)
        if p and (p.get("product_url") or p.get("title")):
            key = p.get("product_url") or p.get("title")
            if key not in seen:
                seen.add(key)
                products.append(p)

    return products

def scrape(base_pattern, start_page, max_pages, out_dir):
    session = requests.Session()
    all_products = []
    seen_urls = set()
    page = start_page

    while page <= max_pages:
        url = base_pattern.format(page=page)
        print(f"[+] Fetching page {page}: {url}")
        try:
            soup = fetch_page(url, session)
        except Exception as e:
            print(f"[!] Error fetching {url}: {e}")
            break

        products = parse_products(soup, url, page)
        new_count = 0
        for p in products:
            key = p.get("product_url") or p.get("title")
            if not key:
                continue
            if key not in seen_urls:
                seen_urls.add(key)
                all_products.append(p)
                new_count += 1

        print(f"    found {len(products)} items on page, {new_count} new overall")

        if not products or new_count == 0:
            print("    no products or no new items — stopping pagination.")
            break

        page += 1
        # modest delay to be gentle to the server
        time.sleep(random.uniform(1.0, 2.5))

    os.makedirs(out_dir, exist_ok=True)
    # latest.json (nadpisywany)
    out_latest = f"{out_dir}/latest.json"
    with open(out_latest, "w", encoding="utf-8") as f:
        json.dump(all_products, f, ensure_ascii=False, indent=2)

    # daily file in Europe/Warsaw date
    local_date = datetime.now(timezone.utc).astimezone(ZoneInfo("Europe/Warsaw")).strftime("%Y%m%d")
    out_daily = f"{out_dir}/tcgplayer_price_guide_{local_date}.json"
    with open(out_daily, "w", encoding="utf-8") as f:
        json.dump(all_products, f, ensure_ascii=False, indent=2)

    # NDJSON with UTC timestamp
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_nd = f"{out_dir}/prices_{ts}.ndjson"
    with open(out_nd, "w", encoding="utf-8") as f:
        for item in all_products:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")

    print(f"[+] Saved {len(all_products)} records to:")
    print(f"    - {out_latest}")
    print(f"    - {out_daily}")
    print(f"    - {out_nd}")

if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python scripts/scrape_tcg.py BASE_PATTERN START_PAGE MAX_PAGES OUT_DIR")
        sys.exit(2)
    base_pattern = sys.argv[1]
    start_page = int(sys.argv[2])
    max_pages = int(sys.argv[3])
    out_dir = sys.argv[4].rstrip("/")
    scrape(base_pattern, start_page, max_pages, out_dir)
