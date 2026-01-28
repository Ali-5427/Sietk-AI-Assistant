from firecrawl import Firecrawl
import json

firecrawl = Firecrawl(api_key="fc-1be629349a154ddf84ef1170d860909a")

crawl_result = firecrawl.crawl(
    url="https://sietk.org",
    limit=100,  # << reduced so it fits in free credits
    scrape_options={
        "formats": ["markdown", "html"],
    },
    poll_interval=30,
)

print("Success:", crawl_result.success)
print("Status:", crawl_result.status)
print("Total pages:", crawl_result.total)
print("Completed:", crawl_result.completed)

docs = []
for doc in crawl_result.data:
    d = {
        "markdown": getattr(doc, "markdown", None),
        "html": getattr(doc, "html", None),
        "metadata": doc.metadata,
    }
    docs.append(d)

with open("sietk_crawl_100.json", "w", encoding="utf-8") as f:
    json.dump(docs, f, ensure_ascii=False, indent=2)

print("Saved", len(docs), "documents to sietk_crawl_100.json")
