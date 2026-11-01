# GIA scraper service

Standalone Render service for looking up GIA Report Check data.

## Local

```powershell
npm install
$env:HOST = "127.0.0.1"
$env:GIA_SCRAPER_TOKEN = "change-this-token"
npm start
```

Request:

```text
GET /gia?reportNo=6202161437
Authorization: Bearer change-this-token
```

## Render

Deploy this repository as a Docker Web Service using `render.yaml`.
Set the generated `GIA_SCRAPER_TOKEN` value in the ERP deployment as well.
