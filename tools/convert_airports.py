"""
@authors David Kitinberg, Amit Bitton, Sagi Hassid
Purpose: Converts airport CSV data into JSON for frontend flight autocomplete.
"""

import csv
import json
import os
import subprocess
import argparse
from pathlib import Path

# Project-relative defaults (no machine-specific absolute paths)
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV_PATH = PROJECT_ROOT / 'tools' / 'data' / 'airports.csv'
DEFAULT_OUT_PATH = PROJECT_ROOT / 'frontend' / 'src' / 'data' / 'airports.json'

keep_types = {"medium_airport", "large_airport"}


def build_country_map(codes):
        unique_codes = sorted({code for code in codes if code})
        if not unique_codes:
                return {}

        js = r"""
const fs = require('fs');
const codes = JSON.parse(fs.readFileSync(0, 'utf8'));
const en = new Intl.DisplayNames(['en'], { type: 'region' });
const he = new Intl.DisplayNames(['he'], { type: 'region' });
const out = {};
for (const code of codes) {
    out[code] = {
        countryName: en.of(code) || code,
        countryNameHebrew: he.of(code) || en.of(code) || code,
    };
}
process.stdout.write(JSON.stringify(out));
"""

        result = subprocess.run(
                ["node", "-e", js],
                input=json.dumps(unique_codes),
            text=True,
            encoding='utf-8',
            errors='replace',
                capture_output=True,
                check=True,
        )
        return json.loads(result.stdout)

def normalize(s):
    if s is None:
        return None
    s2 = s.strip()
    return s2 if s2 != "" else None

def parse_args():
    parser = argparse.ArgumentParser(description='Convert airports CSV to frontend airports.json')
    parser.add_argument('--csv', dest='csv_path', default=str(DEFAULT_CSV_PATH), help='Input airports CSV path')
    parser.add_argument('--out', dest='out_path', default=str(DEFAULT_OUT_PATH), help='Output JSON path')
    return parser.parse_args()


def main():
    args = parse_args()
    csv_path = Path(args.csv_path)
    out_path = Path(args.out_path)

    if not csv_path.exists():
        raise FileNotFoundError(
            f'CSV not found: {csv_path}. Place it in tools/data/airports.csv or pass --csv <path>.'
        )

    with open(csv_path, newline='', encoding='utf-8') as csvfile:
        reader = csv.DictReader(csvfile)
        out = []
        codes = []
        for row in reader:
            t = (row.get('type') or '').strip()
            # Keep only airports that are useful for passenger flight booking.
            if t not in keep_types:
                continue
            country_code = normalize(row.get('iso_country'))
            name = normalize(row.get('name'))
            city = normalize(row.get('municipality'))
            iata = normalize(row.get('iata_code') or row.get('iata'))
            icao = normalize(row.get('icao_code') or row.get('ident'))
            lat = normalize(row.get('latitude_deg'))
            lon = normalize(row.get('longitude_deg'))
            if not country_code or not name:
                continue
            rec = {
                'country': country_code,
                'countryCode': country_code,
                'type': t,
                'airportName': name,
                'city': city,
                'iata': iata,
                'icao': icao,
                'latitude': float(lat) if lat else None,
                'longitude': float(lon) if lon else None
            }
            out.append(rec)
            codes.append(country_code)

    # Ensure output directory exists
    out_path.parent.mkdir(parents=True, exist_ok=True)

    country_map = build_country_map(codes)
    for rec in out:
        info = country_map.get(rec['countryCode'], {})
        rec['countryName'] = info.get('countryName') or rec['countryCode']
        rec['countryNameHebrew'] = info.get('countryNameHebrew') or rec['countryName']

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f'Wrote {len(out)} airport records to {out_path}')


if __name__ == '__main__':
    main()
