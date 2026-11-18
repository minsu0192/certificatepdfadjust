# Browser PDF dependencies

The site serves these fixed versions locally so PDF workflows do not depend on a CDN at runtime. Copyright and license notices are retained in the distributed files.

| File | Version | Upstream distribution |
| --- | --- | --- |
| pdf.min.js / pdf.worker.min.js | PDF.js 3.11.174 | https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/ |
| jszip.min.js | JSZip 3.10.1 | https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js |
| pdf-lib.min.js | pdf-lib 1.17.1 | https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js |

SheetJS is shared from `/tools/ai-table/vendor/xlsx.min.js`. OCR engine/language downloads and the email parser still require an initial internet connection.
