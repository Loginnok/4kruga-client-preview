import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.state/import-libs'))
import concurrent.futures
import hashlib
import io
import json
import re
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal
from urllib.parse import urlparse
from bs4 import BeautifulSoup
from PIL import Image, ImageOps

CACHE = ROOT / '.state/source-import'
MEDIA = ROOT / 'public/media/4kruga'
CACHE.mkdir(parents=True, exist_ok=True)
MEDIA.mkdir(parents=True, exist_ok=True)
BRANDS = ['Xiaomi', 'Kugoo', 'Ninebot', 'Dualtron']
CATEGORIES = [('tires', 'Покрышки и камеры'), ('batteries', 'Аккумуляторы'), ('controllers', 'Контроллеры'), ('motors', 'Мотор-колёса'), ('brakes', 'Тормозные системы'), ('chargers', 'Зарядные устройства'), ('displays', 'Дисплеи'), ('throttles', 'Ручки газа'), ('bearings', 'Подшипники'), ('cables', 'Кабели и разъёмы'), ('body', 'Крылья и пластик'), ('fasteners', 'Крепежи и механизмы'), ('accessories', 'Аксессуары')]

def fetch(url):
    if urlparse(url).hostname != '4kruga.ru':
        raise ValueError('Only the authorized source host is permitted')
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (authorized catalog preview)', 'Accept-Language': 'ru'})
    with urllib.request.urlopen(request, timeout=30) as response:
        if urlparse(response.url).hostname != '4kruga.ru':
            raise ValueError('Unexpected redirect')
        data = response.read(20 * 1024 * 1024)
    return data

def category(name):
    value = name.lower()
    for pattern, key in [(r'покрыш|камер[аы]|шина', 'tires'), (r'аккумулятор', 'batteries'), (r'контроллер|bms|преобразоват', 'controllers'), (r'мотор|колесо в сборе|колесо заднее', 'motors'), (r'тормоз|суппорт|колодк', 'brakes'), (r'зарядное устройство', 'chargers'), (r'дисплей|панель прибор', 'displays'), (r'ручка газа|курок', 'throttles'), (r'подшипник', 'bearings'), (r'кабел|разъем|разъём|провод', 'cables'), (r'крыло|заглуш|кожух|накладк', 'body'), (r'винт|болт|язычок|креп|ось|механизм', 'fasteners')]:
        if re.search(pattern, value):
            return key
    return 'accessories'

def models(name, brand):
    patterns = {
        'Xiaomi': [r'M365', r'1S', r'PRO(?:\s*2)?', r'MI3'],
        'Kugoo': [r'M4(?:\s*PRO)?', r'M5', r'S[123](?:\s*PRO)?', r'F3\s*PRO', r'G[- ]?BOOSTER', r'G2\s*PRO', r'M2(?:\s*PRO)?', r'C1'],
        'Ninebot': [r'G30(?:LP|P|D)?', r'F(?:20|25|30|40)', r'G2', r'ES[1234]?'],
        'Dualtron': [r'MINI', r'(?<=DUALTRON\s)X'],
    }
    result = []
    for pattern in patterns.get(brand, []):
        for match in re.finditer(pattern, name.upper()):
            model = match.group().strip()
            if model not in result:
                result.append(model)
    return result

image_records = {}
def image(url):
    digest = hashlib.sha256(url.encode()).hexdigest()[:20]
    original = CACHE / ('photo-' + digest + Path(urlparse(url).path).suffix)
    data = original.read_bytes() if original.exists() and '--refresh' not in sys.argv else fetch(url)
    original.write_bytes(data)
    photo = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
    if min(photo.size) < 100:
        raise ValueError('Source image is too small')
    if photo.mode not in ('RGB', 'RGBA'):
        photo = photo.convert('RGBA' if 'transparency' in photo.info else 'RGB')
    before = photo.size
    photo.thumbnail((1100, 1100), Image.Resampling.LANCZOS)
    target = MEDIA / (digest + '.webp')
    photo.save(target, 'WEBP', quality=90, method=6)
    record = {'source': url, 'local': '/media/4kruga/' + target.name, 'originalBytes': len(data), 'optimizedBytes': target.stat().st_size, 'originalSize': before, 'size': photo.size, 'sha256': hashlib.sha256(data).hexdigest()}
    image_records[url] = record
    return record['local']

SOURCE_LISTINGS = {'xiaomi': 'https://4kruga.ru/elektrosamokaty/zapchasti-dlja-xiaomi-m365/', 'kugoo': 'https://4kruga.ru/elektrosamokaty/zapchasti-dlja-kugoo/', 'ninebot': 'https://4kruga.ru/elektrosamokaty/zapchasti-dlja-ninebot-/', 'dualtron': 'https://4kruga.ru/elektrosamokaty/zapchasti-dlja-dualtron/'}
for key, url in SOURCE_LISTINGS.items():
    file = CACHE / (key + '.html')
    if '--refresh' in sys.argv or not file.exists():
        file.write_bytes(fetch(url))
selected = {}
for brand in BRANDS:
    soup = BeautifulSoup((CACHE / (brand.lower() + '.html')).read_bytes(), 'html.parser')
    cards = [a for a in soup.select('a.product-thumb[href]') if brand.lower() in a.get('title', '').lower()]
    cards.sort(key=lambda a: (category(a.get('title', '')) not in ('tires', 'batteries', 'controllers', 'brakes'), a.get('title', '')))
    for a in cards[:12]:
        selected.setdefault(a['href'], brand)

def parse_product(item):
    url, listing_brand = item
    cached = CACHE / ('product-' + hashlib.sha256(url.encode()).hexdigest()[:20] + '.html')
    if not cached.exists() or '--refresh' in sys.argv:
        cached.write_bytes(fetch(url))
    soup = BeautifulSoup(cached.read_bytes(), 'html.parser')
    content = soup.select_one('#content')
    name = content.select_one('h1').get_text(' ', strip=True)
    pid_node = soup.select_one('input[name=product_id]')
    pid_match = re.search(r'postData\.product_id\s*=\s*"(\d+)"', str(soup))
    pid = pid_node['value'] if pid_node else pid_match.group(1) if pid_match else None
    if not pid:
        raise ValueError('No verified source product ID')
    price = soup.select_one('[itemprop=price]')
    if price is None:
        raise ValueError('No source price: ' + url)
    price_cents = int(Decimal(price.get('content', price.get_text(strip=True)).replace(',', '.')) * 100)
    availability = soup.select_one('[itemprop=availability]')
    status = availability.get('href', '') if availability else ''
    description = content.select_one('#full_description') or content.select_one('#tab-description')
    description = description.get_text('\n', strip=True) if description else ''
    specs = {}
    for row in content.select('#tab-specification tr'):
        cells = row.select('td')
        if len(cells) == 2:
            specs[cells[0].get_text(' ', strip=True)] = cells[1].get_text(' ', strip=True)
    for line in description.split('\n'):
        if ':' in line and len(line) < 240:
            key, value = line.split(':', 1)
            if key.strip() and value.strip() and len(key) < 80:
                specs.setdefault(key.strip(' *·'), value.strip())
    sku_node = soup.select_one('[itemprop=sku]')
    source_sku = sku_node.get('content', sku_node.get_text(' ', strip=True)) if sku_node else ''
    urls = list(dict.fromkeys(a.get('data-image', a.get('href')) for a in content.select('.product-images-list a[data-image], a.MagicZoom[href]')))
    if not urls:
        raise ValueError('No product gallery: ' + url)
    local_images = [image(source) for source in urls[:3]]
    mentioned = [b for b in BRANDS if b.lower() in name.lower()]
    brand = listing_brand if listing_brand in mentioned else mentioned[0] if mentioned else listing_brand
    return {'id': 'official-' + pid, 'slug': '4kruga-' + pid, 'sku': '4K-' + pid, 'sourceSku': source_sku, 'name': name, 'brand': brand, 'models': models(name, brand), 'category': category(name), 'priceCents': price_cents, 'sourceAvailability': status.rsplit('/', 1)[-1] or 'NotVerified', 'description': description, 'specs': specs, 'images': local_images, 'sourceUrl': url, 'sourceProductId': pid, 'compatibleBrands': mentioned, 'retrievedAt': datetime.fromtimestamp(cached.stat().st_mtime, timezone.utc).isoformat()}

products = []
errors = []
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    futures = {executor.submit(parse_product, item): item[0] for item in selected.items()}
    for future in concurrent.futures.as_completed(futures):
        try:
            products.append(future.result())
        except Exception as error:
            errors.append({'source': futures[future], 'error': str(error)})
products.sort(key=lambda p: (BRANDS.index(p['brand']), p['category'], p['name']))
unique = {p['id']: p for p in products}
products = list(unique.values())
logo_url = 'https://4kruga.ru/image/catalog/logo-4kruga.png'
logo = fetch(logo_url)
(MEDIA / 'logo-original.png').write_bytes(logo)
payload = {'source': 'https://4kruga.ru/', 'retrievedAt': datetime.now(timezone.utc).isoformat(), 'scope': 'Verified product snapshot, not a complete inventory export', 'categories': [list(c) for c in CATEGORIES if any(p['category'] == c[0] for p in products)], 'products': products, 'images': list(image_records.values()), 'logo': {'source': logo_url, 'local': '/media/4kruga/logo-original.png', 'sha256': hashlib.sha256(logo).hexdigest()}, 'contacts': {'name': '4 Круга', 'phone': '+7 (977) 314-60-59', 'phoneHref': '+79773146059', 'email': 'info@4kruga.ru', 'address': 'г. Москва, ул. Тёплый Стан, дом 10', 'hours': 'Пн–сб 10:00–20:00, вс 11:00–17:00', 'sourceUrl': 'https://4kruga.ru/contacts/'}, 'errors': errors}
(ROOT / 'prisma/official-catalog.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'products': len(products), 'images': len(image_records), 'brands': {b: sum(p['brand'] == b for p in products) for b in BRANDS}, 'categories': payload['categories'], 'errors': errors, 'originalBytes': sum(i['originalBytes'] for i in image_records.values()), 'optimizedBytes': sum(i['optimizedBytes'] for i in image_records.values())}, ensure_ascii=False, indent=2))
if errors or len(products) < 30:
    raise SystemExit(1)
