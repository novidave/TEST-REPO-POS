# Public API catalog review

User-provided organization: <https://github.com/public-apis>. Reviewed repository: [public-apis/public-apis](https://github.com/public-apis/public-apis), commit `9fb5cd0bcdce23cf09de555c6c2dc143998c53d3`, README SHA-256 `da54f3235913f6938cda2176d03837790a215ae6b8738ebba7cc10d1bc0a94ec` on 2026-10-28. Only discovery links/notes are retained here; no catalog content or implementation was copied into the app.

Shoptet was not listed in the inspected catalog. Its connector instead uses the vendor-owned `shoptet/developers` OpenAPI source; see [SHOPTET.md](SHOPTET.md). **Shoptet remains the first priority**, including the required merchant API access and unfinished destination/reservation support.

| Catalog lead | Relevance | Decision |
|---|---|---|
| WooCommerce | Merchant REST API; already implemented here | Keep existing driver; a catalog entry adds no new compatibility proof |
| eBay | Official seller API/OAuth link | Future discovery candidate; verify seller inventory contract, permissions, units, write concurrency and terms before implementation |
| Etsy | Official shop/listings API/OAuth link | Future discovery candidate; listings are not automatically complete warehouse inventory |
| OpenTiendas | Commerce API/webhook documentation link | Future discovery candidate; official ownership, stock endpoints, authorization and licensing still need verification |
| Catalog, resale, product-page and price services | Product/price research or public observations | Not accepted as authoritative merchant inventory or a substitute for a merchant API |
| Dummy-product APIs | Synthetic demonstration data | Test/demo use only, never merchant stock |

A listing establishes neither a working connector nor API entitlement, inventory completeness, acceptable automation, certification or redistribution rights. Each candidate needs an official pinned protocol, explicit data semantics, licence/access review, mocked safety tests and authorized staging validation. The catalog's licence cannot grant rights to the listed API services. No additional connector was counted or activated from these discovery links.
