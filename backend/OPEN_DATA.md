# Open Food Facts adapter experiment

This small Node adapter demonstrates open-dataset product ingestion for groceries. The main shopping demo remains home goods sourced through Taobao. The sample is available through the existing `POST /api/products/search` route when the request sets `"source":"open-food-facts-sample"`, or when the server starts with `SHOPPING_PRODUCT_SOURCE=open-food-facts-sample`. It is not a price, stock, promotion, or purchase source.

## API and sample

`src/open-food-facts.mjs` performs a read-only **individual barcode GET** against `https://world.openfoodfacts.org/api/v2/product/{barcode}.json`, with a compact `fields=` selection. The endpoint, `fields` parameter, and identifying User-Agent format are in the [official product endpoint reference](https://openfoodfacts.github.io/documentation/docs/Product-Opener/v2/products/get-product-by-code/) and [API introduction](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/). The selected front image comes from `selected_images`, as recommended by the [official product image schema](https://openfoodfacts.github.io/documentation/docs/Product-Opener/schemas/schemas/product_images/).

Pass a real contact URL or email in the identifying `AppName/Version (contact)` User-Agent for any live use. No credential is needed for reads. For example:

```js
import { getOpenFoodFactsProduct } from './src/open-food-facts.mjs';

const result = await getOpenFoodFactsProduct({
  barcode: '3017620422003',
  userAgent: 'YourApp/1.0 (your-contact@example.org)'
});
```

`data/open-food-facts-sample.json` contains three modest, manually trimmed snapshots from successful live Product API GETs on 2026-10-01. They are real product records, but the fixture is not a complete API response and may differ from later edits by Open Food Facts contributors. Tests use these snapshots and mocked HTTP responses, so they do not depend on the live service.

## Shape and boundaries

`source` stores the dataset identity, canonical product citation URL, exact API URL, retrieval time, and database/content license labels. `facts` contains only returned product attributes (plus explicit `price: null`). `media.images` holds the selected front photo URL and its separate attribution. `semantic` and `generated` stay empty; no style, suitability, or marketing claims are inferred.

Flat `id`, `title`, `imageUrl`, `price`, `originalPrice`, `coupon`, `commissionRate`, `shopName`, `sales`, and `promotionUrl` preserve the legacy card values. `source` is a structured object; `toLegacyCard(item)` projects the exact flat card fields, including a string `source` label, for a future UI integration. Both price fields are `null`, and `promotionUrl` is empty. The canonical `source.url` is for attribution and inspection **only**; it must never be copied into a purchase or promotion link. A missing barcode yields `{ ok: true, item: null }`.

## Licensing and display obligations

The [official Open Food Facts licensing guide](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/license-be-on-the-legal-side/) states that the database is under the **Open Database License (ODbL)**, individual database contents under the **Database Contents License**, and product images under **Creative Commons Attribution ShareAlike (CC BY-SA)**. Its [wiki attribution guidance](https://wiki.openfoodfacts.org/ODBL_License) and [terms of use and reuse](https://world.openfoodfacts.org/terms-of-use) should be checked before public deployment, especially for share-alike obligations and any further rights in packaging graphics.

When displaying an adapted product, visibly credit **Open Food Facts contributors** with a link to `source.url`, and show the photo credit/license near any reused image. Keep the source citation distinct from shopping actions. Do not imply that Open Food Facts endorses a seller, offer, or recommendation. Source data is community contributed and can be incomplete or inaccurate; the [official API documentation](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/) calls out this limitation.

Run the focused checks with `node --test test/open-food-facts.test.mjs` from `backend/`.

To try the offline sample without any Taobao credentials, set `SHOPPING_PRODUCT_SOURCE=open-food-facts-sample` before starting the server, then search for `巧克力`, `可乐`, or `饼干`. These three grocery examples validate the adapter and attribution flow; they are not an evaluation of home-goods recommendation quality.
