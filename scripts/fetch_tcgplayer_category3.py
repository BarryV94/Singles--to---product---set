#!/usr/bin/env python3
"""
scripts/fetch_tcgplayer_category3.py

Pobiera wszystkie grupy dla categoryId=3 z tcgcsv.com, dla każdej grupy pobiera products i prices,
łączy ceny z produktami (po productId) i zapisuje wynik jako skompresowany JSON:
  prices_tcgplayer/tcgplayer_DD_MM_YYYY.json.gz

Uruchom (z repo root): python scripts/fetch_tcgplayer_category3.py
"""

import requests
import time
import json
import os
import gzip
from collections import defaultdict
from datetime import datetime
from typing import List, Dict, Any

BASE = "https://tcgcsv.com/tcgplayer"
CATEGORY_ID = 3
OUT_DIR = "prices_tcgplayer"
SLEEP_BETWEEN_REQUESTS = 0.2
MAX_RETRIES = 3
REQUEST_TIMEOUT = 15  # seconds
USER_AGENT = "tcgcsv-fetcher/1.0 (+https://github.com/yourname/yourrepo)"

def get_json(url: str, params: Dict[str, Any] = None) -> Dict[str, Any]:
    headers = {"User-Agent": USER_AGENT}
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(url, params=params, timeout=REQUEST_TIMEOUT, headers=headers)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print(f"[WARN] Request failed ({attempt}/{MAX_RETRIES}) for {url}: {e}")
            if attempt < MAX_RETRIES:
                time.sleep(1 * attempt)
            else:
                raise

def ensure_out_dir():
    if not os.path.exists(OUT_DIR):
        os.makedirs(OUT_DIR, exist_ok=True)

def filename_for_today() -> str:
    # Format: tcgplayer_DD_MM_YYYY.json.gz
    now = datetime.now()
    fname = f"tcgplayer_{now.strftime('%d_%m_%Y')}.json.gz"
    return os.path.join(OUT_DIR, fname)

def fetch_groups() -> List[Dict[str, Any]]:
    url = f"{BASE}/{CATEGORY_ID}/groups"
    print(f"[INFO] Pobieram grupy: {url}")
    j = get_json(url)
    return j.get("results", [])

def fetch_products_for_group(group_id: int) -> List[Dict[str, Any]]:
    url = f"{BASE}/{CATEGORY_ID}/{group_id}/products"
    print(f"  [INFO] Pobieram produkty dla group {group_id}")
    j = get_json(url)
    return j.get("results", [])

def fetch_prices_for_group(group_id: int) -> List[Dict[str, Any]]:
    url = f"{BASE}/{CATEGORY_ID}/{group_id}/prices"
    print(f"  [INFO] Pobieram ceny dla group {group_id}")
    j = get_json(url)
    return j.get("results", [])

def main():
    # Upewnij się, że skrypt działa z repo root — ale obsłuży też sytuację gdy jest uruchomiony z innego folderu.
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    os.chdir(repo_root)

    ensure_out_dir()
    out_file = filename_for_today()
    fetched_at = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    all_results = []
    errors = []

    try:
        groups = fetch_groups()
    except Exception as e:
        print(f"[ERROR] Nie udało się pobrać listy grup: {e}")
        raise

    print(f"[INFO] Znaleziono {len(groups)} grup. Iteruję...")

    for idx, g in enumerate(groups, start=1):
        group_id = g.get("groupId")
        group_name = g.get("name")
        print(f"[{idx}/{len(groups)}] groupId={group_id} name={group_name}")

        try:
            products = fetch_products_for_group(group_id)
        except Exception as e:
            msg = f"Failed to fetch products for group {group_id}: {e}"
            print(f"  [ERROR] {msg}")
            errors.append({"groupId": group_id, "stage": "products", "error": str(e)})
            time.sleep(SLEEP_BETWEEN_REQUESTS)
            continue

        try:
            prices = fetch_prices_for_group(group_id)
        except Exception as e:
            msg = f"Failed to fetch prices for group {group_id}: {e}"
            print(f"  [WARN] {msg}  — zapisuję puste ceny")
            errors.append({"groupId": group_id, "stage": "prices", "error": str(e)})
            prices = []

        # Map prices by productId (list because multiple price entries per product)
        prices_by_pid = defaultdict(list)
        for p in prices:
            pid = p.get("productId")
            if pid is not None:
                prices_by_pid[pid].append(p)

        # Combine product + prices
        for prod in products:
            pid = prod.get("productId")
            item = {
                "product": prod,
                "prices": prices_by_pid.get(pid, [])
            }
            all_results.append(item)

        time.sleep(SLEEP_BETWEEN_REQUESTS)

    output = {
        "categoryId": CATEGORY_ID,
        "fetchedAt": fetched_at,
        "groups_count": len(groups),
        "products_count": len(all_results),
        "results": all_results,
        "errors": errors
    }

    # Zapis do gzip JSON
    print(f"[INFO] Zapisuję {len(all_results)} produktów do {out_file} ...")
    with gzip.open(out_file, "wt", encoding="utf-8") as gz:
        json.dump(output, gz, ensure_ascii=False, indent=2)

    print("[DONE] Zapisano plik:", out_file)

if __name__ == "__main__":
    main()
