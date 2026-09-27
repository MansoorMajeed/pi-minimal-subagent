# Daily token usage

Run from the repository root with Python 3 (no extra packages):

```bash
python scripts/token_usage.py --days 7
```

For history from before native child sessions were introduced, also scan the
surviving temporary child logs:

```bash
python scripts/token_usage.py --days 7 --legacy
```

The report prints two tables: tokens (including cache tokens) and reported USD
cost. Each has local dates as rows, provider/model IDs as columns, a daily total,
and a final total row. Parent and child usage are combined. Only dates with
recorded usage are shown. Costs are taken from saved usage, not recalculated
using current prices, and are not necessarily your actual invoice.

By default it reads `~/.pi/agent/sessions` (or `$PI_CODING_AGENT_DIR/sessions`),
including nested `.pi-minimal-subagent` child session directories. `--legacy`
also reads `$TMPDIR/pi-minsub` (normally `/tmp/pi-minsub`). A native child session
takes precedence over its temporary log. Repeated parent result/status records
and copied session entries are deduplicated.

Use `--sessions PATH` and `--logs PATH` to override the input roots. Local dates
use the system timezone; `TZ=America/New_York python scripts/token_usage.py`
provides an explicit timezone on systems supporting `TZ`.

Missing or partial child files may leave saved totals without reliable model/day
attribution. These appear separately as **unattributed across all scanned
history**, not in the date-filtered tables. A `*` marks a cost subtotal with
missing cost records. In-progress or interrupted calls may have unrecorded usage.
The script reads files only; it cannot recover deleted history or preserve
`/tmp` across reboots.

Run the script tests:

```bash
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s scripts -p 'test_*.py'
```
