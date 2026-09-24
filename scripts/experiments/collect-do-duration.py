"""Read platform metrics without calling the application. Requires Python 3.10+.

Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, DO_NAMESPACE_ID, START, and END.
START/END are UTC ISO timestamps. Use separate namespaces for each deployment.
Output omits account/namespace/object identifiers and assigns stable object aliases
within this response. Keep a private copy of the query inputs for your own audit.
"""

import json
import os
import urllib.request

query = """query($account:String!, $namespace:String!, $start:Time!, $end:Time!) {
  viewer { accounts(filter:{accountTag:$account}) {
    durableObjectsPeriodicGroups(limit:10000,
      filter:{namespaceId:$namespace, datetime_geq:$start, datetime_lt:$end}) {
      count
      dimensions {datetimeMinute objectId coloCode}
      sum {duration cpuTime activeTime}
      avg {sampleInterval}
    }
  }}
}"""
variables = {
    "account": os.environ["CLOUDFLARE_ACCOUNT_ID"],
    "namespace": os.environ["DO_NAMESPACE_ID"],
    "start": os.environ["START"],
    "end": os.environ["END"],
}
request = urllib.request.Request(
    "https://api.cloudflare.com/client/v4/graphql",
    data=json.dumps({"query": query, "variables": variables}).encode(),
    headers={
        "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"],
        "Content-Type": "application/json",
    },
)
with urllib.request.urlopen(request, timeout=60) as response:
    result = json.load(response)
if result.get("errors"):
    raise RuntimeError(json.dumps(result["errors"]))
rows = result["data"]["viewer"]["accounts"][0]["durableObjectsPeriodicGroups"]
if len(rows) == 10000:
    raise RuntimeError("Result limit reached; query a shorter interval")
aliases = {value: f"object-{index + 1}" for index, value in enumerate(sorted({
    row["dimensions"]["objectId"] for row in rows
}))}
for row in rows:
    dimensions = row["dimensions"]
    dimensions["object"] = aliases[dimensions.pop("objectId")]
rows.sort(key=lambda row: (row["dimensions"]["datetimeMinute"], row["dimensions"]["object"]))
print(json.dumps({"start": variables["start"], "end": variables["end"], "rows": rows}, indent=2))
