#!/usr/bin/env python3
"""
scripts/scrape_tcg.py
Simple scraper using requests + BeautifulSoup.
Usage:
  python scripts/scrape_tcg.py BASE_PATTERN START_PAGE MAX_PAGES OUT_DIR
E.g.
  python scripts/scrape_tcg.py "https://www.tcgplayer.com/search/pokemon/product?productLineName=pokemon&page={page}&view=grid&ProductTypeName=Sealed+Products" 1 200 tcg-sealed-price-guide
"""
import sys
import time
import json
import random
from datetime import datetime, timezone
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

def parse_products(soup, base_url, page_number):
    products = []
    anchors = soup.select("a[href*='/product/']")
    seen = set()
    pos = 0
    for a in anchors:
        href = a.get("href")
        if not href:
            continue
        product_url = urljoin(base_url, href.split("?")[0])
        if product_url in seen:
            continue
        seen.add(product_url)
        pos += 1
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
        if not price_text:
            parent = a.parent
            if parent:
                cand = parent.select_one(".price, .product-price, .search-result__price, .card-price")
                if cand:
                    price_text = cand.get_text(strip=True)
        products.append({
            "title": title,
            "product_url": product_url,
            "image": img_url,
            "price_text": price_text,
            "page": page_number,
            "position_on_page": pos,
            "scraped_at": datetime.now(timezone.utc).astimezone().isoformat()
        })
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

        # jeśli brak produktów lub brak nowych => prawdopodobnie ostatnia strona
        if not products or new_count == 0:
            print("    no products or no new items — stopping pagination.")
            break

        page += 1
        time.sleep(random.uniform(1.0, 2.5))

    os.makedirs(out_dir, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_json = f"{out_dir}/latest.json"
    out_nd = f"{out_dir}/prices_{ts}.ndjson"

    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(all_products, f, ensure_ascii=False, indent=2)

    with open(out_nd, "w", encoding="utf-8") as f:
        for item in all_products:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")

    print(f"[+] Saved {len(all_products)} records to {out_json} and {out_nd}")

if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python scripts/scrape_tcg.py BASE_PATTERN START_PAGE MAX_PAGES OUT_DIR")
        sys.exit(2)
    base_pattern = sys.argv[1]
    start_page = int(sys.argv[2])
    max_pages = int(sys.argv[3])
    out_dir = sys.argv[4].rstrip("/")
    scrape(base_pattern, start_page, max_pages, out_dir)
