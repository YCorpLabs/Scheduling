#!/usr/bin/env python3
"""Read-only deployment checks. No login, provider action or mail is performed."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "apps/booking/public"


def fetch(origin, path):
    # curl with no cookies, bearer credentials, redirects or verbose output.
    with tempfile.TemporaryDirectory(prefix="scheduling-deployment-check-") as scratch:
        headers, body = Path(scratch) / "headers", Path(scratch) / "body"
        status = subprocess.check_output([
            "curl", "--silent", "--show-error", "--max-time", "20",
            "--proto", "=https", "--dump-header", str(headers),
            "--output", str(body), "--write-out", "%{http_code}", origin + path,
        ], text=True)
        policies = [line.split(":", 1)[1].strip() for line in headers.read_text().splitlines()
                    if line.lower().startswith("content-security-policy:")]
        return int(status), policies, body.read_bytes()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True, help="HTTPS origin of the deployed instance, e.g. https://scheduling.your-domain")
    args = parser.parse_args()
    url = urlsplit(args.origin)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or url.path:
        parser.error("--origin must be an HTTPS origin without a path or credentials")
    failures = []
    status, _, body = fetch(args.origin, "/api/health")
    ready = status == 200 and json.loads(body).get("ready") is True
    if not ready:
        failures.append("Public configuration health is not ready")
    print(f"Configuration health: {'ready' if ready else 'FAILED'} (not provider/job health)")
    for path in ("/api/live/settings", "/api/live/operations", "/api/live/workspaces", "/api/live/workspace", "/api/live/integrations", "/api/live/my-calendar", "/api/live/my-calendar/readiness", "/api/live/member-calendars", "/api/live/calendar-contributions", "/api/live/account/export", "/api/live/workspace/export", "/api/live/account/deletion/prepare", "/api/live/account/deletion/confirm"):
        status, _, _ = fetch(args.origin, path)
        if status != 401:
            failures.append(f"Unauthenticated {path} returned {status}, expected 401")
    for path in ("/", "/studio", "/manage/h_probe/booking-probe"):
        status, policies, _ = fetch(args.origin, path)
        if status != 200 or not any("frame-ancestors 'none'" in policy for policy in policies):
            failures.append(f"Owner/private framing protection missing on {path}")
    for path in ("/book?embed=1", "/b/h_probe/intro?embed=1"):
        status, policies, _ = fetch(args.origin, path)
        if status != 200 or any("frame-ancestors" in policy for policy in policies):
            failures.append(f"Public guest embedding policy unexpected on {path}")
    # Verify every deployed public source file, excluding the server-only header
    # configuration. Exact asset matches do not establish the Worker code version.
    checked = 0
    for source in sorted(PUBLIC.iterdir()):
        if not source.is_file() or source.name.startswith("_"):
            continue
        # Static Assets canonically redirects /index.html to /.
        status, _, data = fetch(args.origin, "/" if source.name == "index.html" else "/" + source.name)
        if status != 200 or hashlib.sha256(data).digest() != hashlib.sha256(source.read_bytes()).digest():
            failures.append(f"Deployed asset differs from local source: {source.name}")
        checked += 1
    print(f"Checked {checked} public assets, owner access denial and framing policies")
    if failures:
        for failure in failures:
            print("FAIL: " + failure)
        return 1
    print("Read-only deployment checks passed. Record the Worker version separately.")
    print("Real OAuth, calendar lifecycle, timed delivery, restore and alerts remain separate acceptance.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Deployment check could not complete: {type(error).__name__}")
