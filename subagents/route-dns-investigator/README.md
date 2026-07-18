# Route / DNS Investigator

Read-only Cloudflare routing investigator for AFO Workers.

Version: 0.1.1

v0.1.1 adds account-wide zone discovery and account-wide Worker route scanning by default.

Tools:

- subagent_status
- list_account_zones
- resolve_zone
- list_dns_records
- list_worker_routes
- list_custom_domains
- get_workers_dev_url
- smoke_endpoint
- analyze_route_conflicts
- investigate_route_dns

Important behavior:

- jaredtechfit.workers.dev is a workers.dev account subdomain, not a DNS zone.
- agentfeedoptimization.com is the recommended default custom-domain zone.
- When no zone is supplied, route scans now look across visible account zones by default.
- For workers.dev URLs, pass the full URL and script_name.
- For custom domains, pass the hostname or URL and the intended script_name.

Recommended runtime values:

ACCOUNT_SUBDOMAIN = jaredtechfit
DEFAULT_ZONE_NAME = agentfeedoptimization.com
DEFAULT_SCAN_ALL_ZONES = true

The credential attached to the Worker must have read access for zones, DNS records, Worker routes, Worker custom domains, and Worker script/subdomain metadata. No mutation tools are implemented.
