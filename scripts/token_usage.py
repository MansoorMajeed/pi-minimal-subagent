#!/usr/bin/env python3
"""Report Pi parent + child tokens and recorded costs by local day and model."""

import argparse
from collections import defaultdict
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import sys
import tempfile


def local_day(value):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000).date().isoformat()
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone().date().isoformat()


def empty():
    return {'tokens': 0, 'cost': 0.0, 'missing_cost': False}


def add(total, value):
    total['tokens'] += value['tokens']
    total['cost'] += value['cost']
    total['missing_cost'] |= value['missing_cost']


def measures(usage, warnings):
    if not isinstance(usage, dict):
        warnings.add('Some assistant messages have no recorded usage; totals are incomplete.')
        return {'tokens': 0, 'cost': 0.0, 'missing_cost': True}
    tokens = usage.get('totalTokens')
    if not isinstance(tokens, (int, float)):
        parts = [usage.get(k) for k in ('input', 'output', 'cacheRead', 'cacheWrite')]
        tokens = sum(v for v in parts if isinstance(v, (int, float)))
        if not any(isinstance(v, (int, float)) for v in parts):
            warnings.add('Some usage records have no token counts; totals are incomplete.')
    cost = usage.get('cost')
    if isinstance(cost, dict):
        cost = cost.get('total')
    missing = not isinstance(cost, (int, float))
    if missing:
        warnings.add('Some costs are missing; starred cost cells are recorded subtotals only.')
    return {'tokens': int(tokens), 'cost': 0.0 if missing else cost, 'missing_cost': missing}


def read_rows(path, warnings):
    try:
        with path.open() as stream:
            for number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                    if isinstance(row, dict):
                        yield row
                except ValueError:
                    warnings.add(f'Skipped invalid or unfinished JSON: {path}:{number}')
    except OSError as error:
        warnings.add(f'Could not read {path}: {error}')


def child_key(path):
    # Native sessions and legacy logs share <run>/<1-based index>-<agent>.jsonl.
    index = path.stem.split('-', 1)[0]
    return (path.parent.name, int(index) - 1) if index.isdigit() else (str(path.resolve()), 0)


def collect(sessions, logs, legacy=False):
    totals = defaultdict(empty)
    unknown = empty()
    warnings = set()
    seen = set()
    summaries = {}
    native_paths = {}
    log_paths = {}
    files = sorted(sessions.rglob('*.jsonl'))

    def account(message, fallback=None):
        value = measures(message.get('usage'), warnings)
        try:
            day = local_day(message.get('timestamp') or fallback)
        except (ValueError, TypeError, AttributeError, OverflowError, OSError):
            add(unknown, value)
            warnings.add('Some usage has no usable timestamp and is unattributed.')
            return value
        model = '/'.join(str(message.get(k) or 'unknown') for k in ('provider', 'model'))
        add(totals[day, model], value)
        return value

    def unique(row):
        identity = (row.get('id'), row.get('timestamp'))
        if not identity[0]:
            return True
        if identity in seen:
            return False
        seen.add(identity)
        return True

    for path in files:
        if any(part.endswith('.pi-minimal-subagent') for part in path.parts):
            native_paths[child_key(path)] = path.resolve()
            continue
        for row in read_rows(path, warnings):
            if not unique(row):
                continue
            message = row.get('message') or {}
            if row.get('type') == 'message' and message.get('role') == 'assistant':
                account(message, row.get('timestamp'))
            details = None
            if message.get('role') == 'toolResult' and message.get('toolName') == 'subagent':
                details = message.get('details')
            elif row.get('type') == 'custom_message' and row.get('customType') == 'minimal-subagent-complete':
                details = row.get('details')
            if not isinstance(details, dict):
                continue
            for index, result in enumerate(details.get('results') or []):
                if not isinstance(result, dict):
                    continue
                log = Path(result['logPath']).resolve() if result.get('logPath') else None
                native = Path(result['sessionPath']).resolve() if result.get('sessionPath') else None
                run = details.get('jobId') or (Path(details['runDir']).name if details.get('runDir') else None)
                key = (run, index) if run else child_key(native or log or path)
                if native and native.is_file():
                    native_paths[key] = native
                if log and log.is_file():
                    log_paths[key] = log
                if not isinstance(result.get('usage'), dict):
                    continue
                value = measures(result['usage'], warnings)
                previous = summaries.get(key)
                if previous and previous != value:
                    warnings.add('Different saved totals exist for a child; using the largest token snapshot.')
                if previous is None or value['tokens'] > previous['tokens']:
                    summaries[key] = value

    if legacy:
        for path in sorted(logs.glob('*/*.jsonl')):
            log_paths.setdefault(child_key(path), path.resolve())
    captured = {}
    read_paths = {}
    for key in sorted(set(native_paths) | (set(log_paths) if legacy else set())):
        is_native = key in native_paths
        path = native_paths[key] if is_native else log_paths[key]
        if path in read_paths:
            captured[key] = read_paths[path]
            continue
        count = empty()
        finished = is_native
        for row in read_rows(path, warnings):
            message = row.get('message') or {}
            if is_native:
                if row.get('type') == 'message' and message.get('role') == 'assistant' and unique(row):
                    add(count, account(message, row.get('timestamp')))
            else:
                if row.get('type') == 'agent_end':
                    finished = True
                if row.get('type') == 'message_end' and message.get('role') == 'assistant':
                    add(count, account(message))
        captured[key] = count
        read_paths[path] = count
        if not finished:
            warnings.add('Some legacy logs are unfinished; only completed message events are counted.')

    for key, saved in summaries.items():
        recorded = captured.get(key)
        if recorded is None:
            add(unknown, saved)
        else:
            # Preserve recoverable totals without inventing their model or day.
            remainder = {'tokens': max(0, saved['tokens'] - recorded['tokens']),
                         'cost': max(0.0, saved['cost'] - recorded['cost']),
                         'missing_cost': saved['missing_cost']}
            if remainder['tokens'] or remainder['cost'] > 1e-9:
                add(unknown, remainder)
                warnings.add('Some saved child totals exceed captured messages; the remainder is unattributed.')
    if not legacy and (unknown['tokens'] or unknown['cost']):
        warnings.add('Use --legacy to recover model/day details from surviving temporary child logs.')
    return totals, unknown, warnings


def print_table(title, days, models, totals, field):
    def format_value(value):
        if field == 'tokens':
            return f'{value["tokens"]:,}'
        return f'${value["cost"]:,.4f}' + ('*' if value['missing_cost'] else '')

    rows = []
    columns = [empty() for _ in models]
    grand = empty()
    for day in days:
        day_total = empty()
        cells = []
        for index, model in enumerate(models):
            value = totals.get((day, model), empty())
            cells.append(format_value(value))
            add(columns[index], value)
            add(day_total, value)
        rows.append([day, *cells, format_value(day_total)])
        add(grand, day_total)
    rows.append(['TOTAL', *(format_value(v) for v in columns), format_value(grand)])
    headers = ['Day', *models, 'Total']
    widths = [max(len(row[i]) for row in [headers, *rows]) for i in range(len(headers))]
    print(f'\n{title}')
    for row in [headers, *rows]:
        print('  '.join(cell.ljust(width) if i == 0 else cell.rjust(width)
                        for i, (cell, width) in enumerate(zip(row, widths))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    agent_dir = Path(os.environ.get('PI_CODING_AGENT_DIR', '~/.pi/agent')).expanduser()
    parser.add_argument('--days', type=int, default=7, help='local calendar days including today (default: 7)')
    parser.add_argument('--legacy', action='store_true', help='also read old temporary child logs; native sessions take precedence')
    parser.add_argument('--sessions', type=Path, default=agent_dir / 'sessions')
    parser.add_argument('--logs', type=Path, default=Path(tempfile.gettempdir()) / 'pi-minsub', help='temporary log root (used with --legacy)')
    args = parser.parse_args()
    if args.days < 1:
        parser.error('--days must be at least 1')
    sessions, logs = args.sessions.expanduser(), args.logs.expanduser()
    if not sessions.is_dir() and not (args.legacy and logs.is_dir()):
        parser.error('no input directory exists (temporary logs require --legacy)')
    totals, unknown, warnings = collect(sessions, logs, legacy=args.legacy)
    today = datetime.now().date()
    start = (today - timedelta(days=args.days - 1)).isoformat()
    days = sorted({day for day, _ in totals if start <= day <= today.isoformat()})
    models = sorted({model for day, model in totals if day in days})
    print(f'Local dates: {start} through {today} (system timezone; TZ override supported)')
    print('Combined parent + child usage; native sessions' + (' + legacy logs.' if args.legacy else '.'))
    print_table('Tokens (including cache)', days, models, totals, 'tokens')
    print_table('Reported cost (USD)', days, models, totals, 'cost')
    if unknown['tokens'] or unknown['cost'] or unknown['missing_cost']:
        cost = f'${unknown["cost"]:,.4f}' + ('*' if unknown['missing_cost'] else '')
        print(f'\nUnattributed across ALL scanned history: {unknown["tokens"]:,} tokens, {cost}; excluded above.')
    print('\nRecorded usage only, not an invoice. Missing/unfinished calls may be absent. * = incomplete cost.')
    for warning in sorted(warnings):
        print(f'Warning: {warning}', file=sys.stderr)


if __name__ == '__main__':
    main()
