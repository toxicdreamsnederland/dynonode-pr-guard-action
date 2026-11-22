# `@dynonode/pr-guard-action`

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](./LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-339933.svg)](./package.json)

> **Zero-dependency GitHub Marketplace Action & CLI that scans changed `.md` and `.html` files in pull requests for broken links and WCAG 2.2 AA accessibility regressions.**

Catches regressions in CI before merge—without installing Chromium, Playwright, or 200 MB of `node_modules`:

1. **Dead Local & HTTP(S) Links:** Verifies relative file paths and public external URLs (with SSRF protection and `HEAD` -> `GET` fallback).
2. **WCAG 2.2 SC 1.1.1 (`img-alt`):** Flags non-decorative `<img>` elements missing an `alt` attribute.
3. **WCAG 2.2 SC 3.1.1 (`html-has-lang`):** Flags `<html>` documents missing a valid `lang` attribute.
4. **WCAG 2.2 SC 2.4.4 / 4.1.2 (`link-name` / `button-name`):** Flags empty `<a href="..."></a>` and `<button></button>` controls lacking text, `aria-label`, `aria-labelledby`, or image `alt`.

---

## GitHub Actions Quickstart

Create `.github/workflows/pr-guard.yml`:

```yaml
name: PR Link & WCAG Guard

on:
  pull_request:
    paths:
      - "**/*.md"
      - "**/*.html"

jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - name: Scan changed Markdown & HTML files
        uses: dynonode/pr-guard-action@v1
        with:
          check-external-links: "true"
          fail-on-issues: "true"
```

## Local CLI Usage

```bash
npx @dynonode/pr-guard-action docs/ public/
```

---

## Inputs & Outputs

| Input | Default | Description |
| :--- | :--- | :--- |
| `paths` | `""` (git diff) | Comma- or newline-separated files/directories to scan. |
| `check-external-links` | `"true"` | Perform SSRF-safe HTTP `HEAD`/`GET` status checks on `https://` links. |
| `timeout-ms` | `"6000"` | Per-URL HTTP timeout in milliseconds. |
| `fail-on-issues` | `"true"` | Exit with code `1` if broken links or WCAG errors are detected. |

| Output | Description |
| :--- | :--- |
| `issues-count` | Total broken links + WCAG issues found. |
| `broken-links-count` | Number of dead local or HTTP(S) links. |
| `wcag-issues-count` | Number of WCAG 2.2 HTML errors. |
| `markdown-report` | Clean Markdown PR summary table. |

---

## Need Live Production Monitoring Beyond PR Static Checks?

- **European Accessibility Act (EAA) & WCAG 2.2 AA Full-DOM Batch Audits:** Scan up to 50 live rendered URLs with computed contrast & ARIA fixes via **[A11y Sentinel (`wcag.dynonode.com`)](https://wcag.dynonode.com/)**.
- **24/7 HTTP-200 Out-of-Stock & Affiliate Tag Protection:** Catch silent out-of-stock product pages and stripped `?tag=` parameters via **[RevenueGuard 404 (`revenueguard.dynonode.com`)](https://revenueguard.dynonode.com/)**.

*MIT License · Maintained by Toxic Dreams (d/b/a [DynoNode](https://dynonode.com), Dirk Boutsstraat 22, 5753 BD Deurne, NL · KvK 74716344 · VAT NL002407479B40).*
