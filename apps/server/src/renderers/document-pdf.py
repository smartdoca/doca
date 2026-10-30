"""Render self-contained HTML. Never load a host file or network URL."""
import json
import logging
import math
import sys
from urllib.parse import urlsplit

from weasyprint import CSS, HTML, URLFetcher
from weasyprint.urls import FatalURLFetchingError
from weasyprint.text.fonts import FontConfiguration


def main():
    request = json.loads(sys.stdin.buffer.read(64 * 1024 * 1024 + 1024))
    width = request["width"]
    if not isinstance(width, int) or not 400 <= width <= 2000:
        raise ValueError("pdf_invalid_request")
    failures = []

    class ProjectionFetcher(URLFetcher):
        def fetch(self, url, headers=None):
            if urlsplit(url).scheme != "data":
                raise ValueError("pdf_external_resource_forbidden")
            return super().fetch(url, headers)

    fetch = ProjectionFetcher(allowed_protocols={"data"}, fail_on_errors=True)

    class Errors(logging.Handler):
        def emit(self, record):
            message = record.getMessage()
            # Tagging diagnostics (for example an optional image alt label) do
            # not indicate missing artwork. Fetch/decoding errors still fail.
            if (record.levelno >= logging.ERROR and record.module != "tags") or "cannot be loaded" in message:
                failures.append(message)

    logger = logging.getLogger("weasyprint")
    logger.addHandler(Errors())
    logger.setLevel(logging.WARNING)
    fonts = FontConfiguration()
    style = CSS(string=f"""
      @page {{ size: {width}px {round(width * math.sqrt(2))}px; margin: 24px 0; }}
      html, body {{ margin: 0; padding: 0; width: {width}px; }}
      * {{ print-color-adjust: exact; }}
      tr, figure, img, .sk-image, .sk-diagram-figure {{ break-inside: avoid; }}
      h1, h2, h3, h4, h5, .sk-block-heading-one, .sk-block-heading-two,
      .sk-block-heading-three {{ break-after: avoid; }}
      p {{ orphans: 3; widows: 3; }}
      thead {{ display: table-header-group; }}
    """, font_config=fonts, url_fetcher=fetch, media_type="screen")
    document = HTML(string="<!doctype html><html lang='und'><head><meta charset='utf-8'><title>Doca document</title></head><body>"
                    + request["html"] + "</body></html>",
                    url_fetcher=fetch, media_type="screen")
    output = document.write_pdf(stylesheets=[style], font_config=fonts, pdf_tags=True)
    if failures:
        raise ValueError("pdf_resource_failed: " + failures[0])
    sys.stdout.buffer.write(output)


if __name__ == "__main__":
    try:
        main()
    except (Exception, FatalURLFetchingError) as error:
        print(type(error).__name__ + ": " + str(error)[:256].split("data:")[0], file=sys.stderr)
        sys.exit(1)
