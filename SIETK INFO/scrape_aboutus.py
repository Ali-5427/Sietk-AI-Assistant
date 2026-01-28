from firecrawl import Firecrawl
import json

firecrawl = Firecrawl(api_key="fc-1be629349a154ddf84ef1170d860909a")

page_url = "https://sietk.org/index.php"

result = firecrawl.scrape(
    page_url,
    formats=["markdown", "html"],  # note: formats=..., not scrape_options
)

# result is usually a dict-like or object; recent SDK returns .data list
docs = []
data_list = getattr(result, "data", result)  # handle both shapes

for doc in data_list:
    # doc may be a pydantic model or dict; handle both
    if hasattr(doc, "markdown") or hasattr(doc, "html"):
        item = {
            "url": getattr(doc.metadata, "source_url", page_url) if getattr(doc, "metadata", None) else page_url,
            "markdown": getattr(doc, "markdown", None),
            "html": getattr(doc, "html", None),
            "metadata": doc.metadata if getattr(doc, "metadata", None) else None,
        }
    else:
        # dict shape
        item = {
            "url": doc.get("metadata", {}).get("sourceURL", page_url),
            "markdown": doc.get("markdown"),
            "html": doc.get("html"),
            "metadata": doc.get("metadata"),
        }
    docs.append(item)

with open("index.json", "w", encoding="utf-8") as f:
    json.dump(docs, f, ensure_ascii=False, indent=2)

print("Saved", len(docs), "documents to index.json")
