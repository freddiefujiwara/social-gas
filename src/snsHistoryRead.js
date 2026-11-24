// SNS snapshot history, read side (action=sns_history).

import { SNS_HISTORY_ACCOUNT_COLUMNS } from './historyWrite.js';
import { SNS_DAY_MS, jstDateKey_ } from './instagramDaily.js';
import { SNS_HISTORY_CACHE_KEY, SNS_HISTORY_CACHE_SECONDS, getCachedText_, openHistorySpreadsheet_, putCachedText_, sheetReadCache_ } from './sheetRead.js';

// --- SNS snapshot history, read side (action=sns_history) ---
// The authenticated counterpart of the append above: the /ga
// trend charts read the "account" sheet back through this action.
// Only the columns the charts need are served, and the read is
// capped at the newest 6600 rows (about 275 days at hourly
// collections). The window is sized by what the front asks for:
// the Instagram trend's longest period is 180 days, and its
// 全期間 option plots everything served, so the cap is a safety
// valve rather than the period selector — the front slices the
// days it shows. A full window serializes to roughly 3.1M
// characters (about 460 per row), which is also why the payload
// cache chunk cap below sits at 120. An unset property or a
// missing/empty sheet is not an error: the history simply has
// not started yet, so rows is [].
//
// The served rows are downsampled (see
// downsampleSnsHistoryRows_): the newest seven days keep every
// hourly row, older days keep one representative row each. The
// front collapses every series it draws — trend charts, the
// day-over-day and trailing-window deltas, the X balance
// runway and daily usage — to one point per Asia/Tokyo
// calendar day (the day's last reported value per metric), so
// a representative that carries exactly those per-day last
// values leaves every displayed figure unchanged while the
// payload stops growing by a row an hour forever.

const SNS_HISTORY_RESPONSE_COLUMNS = [
  'collected_at',
  'ig_followers',
  'threads_followers',
  'youtube_subscribers',
  'total_followers',
  'media_count',
  'views_30d',
  'non_follower_pct',
  'reach_30d',
  'interactions_total',
  // The interaction breakdown rides along so the Instagram
  // tab can chart each kind of reaction, not just the total.
  'interactions_likes',
  'interactions_comments',
  'interactions_shares',
  'interactions_saves',
  'follows_30d',
  'unfollows_30d',
  'yt_total_views',
  'x_followers',
  // The X API credit balance rides along so the X tab can show
  // the current balance and estimate its runway from the stored
  // series itself.
  'x_api_balance_usd',
];
const SNS_HISTORY_MAX_ROWS = 6600;

// Sheets hands date cells back as Date objects and numbers as
// numbers, while untouched cells come back as ''. Normalize to the
// JSON shape the admin screen expects: an ISO string for
// collected_at (null when the cell holds no timestamp at all) and
// numbers-or-null for everything else.
function snsHistoryTimestampCell_(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return typeof value === 'string' && value !== '' ? value : null;
}

function snsHistoryNumberCell_(value) {
  // Only a finite number or a non-blank numeric string reads
  // as a number. Bare Number() coercion would read a boolean
  // cell as 1 / 0, an array as its element, whitespace as 0
  // and a Date as its epoch milliseconds — values the cell
  // never reported — and would throw on a value whose
  // toString is not a function.
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

// How far back the served history keeps every hourly row,
// measured from the newest row: rows inside the window are
// served untouched. Anchoring at the newest row (rather than
// the wall clock) keeps the freshest week at full resolution
// even if collections stall, and matches the front's reading
// of "the last seven days" as the last seven days of data.
const SNS_HISTORY_HOURLY_WINDOW_MS = 7 * SNS_DAY_MS;

// Collapses rows older than the hourly window to one
// representative row per Asia/Tokyo calendar day. The
// representative is the day's last row, with any column that
// row leaves null filled by the day's last reported (non-null)
// value for that column — which is exactly the value the
// front's per-day collapse (last collection of the day that
// carries the metric) reads, so every daily point, delta and
// derived figure the screen computes is unchanged. A column
// null all day stays null. Rows are expected ascending by
// collected_at (assembleSnsHistoryResponse_ sorts before
// calling); representatives keep that order and precede the
// untouched window rows. Returns { rows, downsampled } with
// downsampled true when at least one row was collapsed away.
function downsampleSnsHistoryRows_(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { rows: rows || [], downsampled: false };
  }
  const newestMs = Date.parse(rows[rows.length - 1].collected_at);
  if (!Number.isFinite(newestMs)) {
    return { rows, downsampled: false };
  }
  const cutoffMs = newestMs - SNS_HISTORY_HOURLY_WINDOW_MS;
  const representativeByDay = new Map();
  const kept = [];
  let dropped = 0;
  rows.forEach((row) => {
    const atMs = Date.parse(row.collected_at);
    if (!Number.isFinite(atMs) || atMs >= cutoffMs) {
      kept.push(row);
      return;
    }
    const day = jstDateKey_(atMs);
    const representative = representativeByDay.get(day);
    if (!representative) {
      representativeByDay.set(day, Object.assign({}, row));
      return;
    }
    dropped += 1;
    Object.keys(row).forEach((column) => {
      if (row[column] !== null && row[column] !== undefined) {
        representative[column] = row[column];
      }
    });
  });
  if (dropped === 0) {
    return { rows, downsampled: false };
  }
  return {
    rows: [...representativeByDay.values(), ...kept],
    downsampled: true,
  };
}

// The history response rides the same read cache as the
// other sheet-backed payloads: the hourly collection
// precomputes it (see precomputeReadCaches_), so a read
// normally never opens the sheet. On a miss the response is
// assembled from the sheet — reading only the newest
// SNS_HISTORY_MAX_ROWS data rows, never the whole tab: the
// account tab grows by a row an hour forever, and rows older
// than the cap were sliced away after the read anyway. The
// cached payload is the downsampled one the response serves.
function buildSnsHistoryResponse_() {
  const cache = sheetReadCache_();
  if (cache) {
    const hit = getCachedText_(cache, SNS_HISTORY_CACHE_KEY);
    if (hit) {
      try {
        const parsed = JSON.parse(hit);
        if (parsed && Array.isArray(parsed.rows)) {
          return parsed;
        }
      } catch (err) {
        // A corrupt cache entry is ignored; the history is rebuilt.
      }
    }
  }
  const response = assembleSnsHistoryResponse_();
  if (cache) {
    putCachedText_(
      cache,
      SNS_HISTORY_CACHE_KEY,
      JSON.stringify(response),
      SNS_HISTORY_CACHE_SECONDS
    );
  }
  return response;
}

function assembleSnsHistoryResponse_(openedSpreadsheet) {
  const empty = { ok: true, action: 'sns_history', rows: [] };
  const spreadsheet = openedSpreadsheet || openHistorySpreadsheet_();
  if (!spreadsheet) {
    return empty;
  }
  const sheet = spreadsheet.getSheetByName('account');
  if (!sheet || sheet.getLastRow() < 2) {
    return empty;
  }
  const lastRow = sheet.getLastRow();
  const firstDataRow = Math.max(2, lastRow - SNS_HISTORY_MAX_ROWS + 1);
  const header = sheet
    .getRange(1, 1, 1, SNS_HISTORY_ACCOUNT_COLUMNS.length)
    .getValues()[0]
    .map((cell) => String(cell));
  const values = [header].concat(
    sheet
      .getRange(
        firstDataRow,
        1,
        lastRow - firstDataRow + 1,
        SNS_HISTORY_ACCOUNT_COLUMNS.length
      )
      .getValues()
  );
  const columnIndex = {};
  SNS_HISTORY_RESPONSE_COLUMNS.forEach((column) => {
    const index = header.indexOf(column);
    // A column added after the sheet was created (x_followers)
    // is missing from the stored header until someone extends
    // it; its cells still sit at the canonical position of
    // SNS_HISTORY_ACCOUNT_COLUMNS, so fall back to that.
    columnIndex[column] =
      index >= 0 ? index : SNS_HISTORY_ACCOUNT_COLUMNS.indexOf(column);
  });
  const rows = values
    .slice(1)
    .map((cells) => {
      const row = {};
      SNS_HISTORY_RESPONSE_COLUMNS.forEach((column) => {
        const index = columnIndex[column];
        const cell = index >= 0 ? cells[index] : '';
        row[column] =
          column === 'collected_at'
            ? snsHistoryTimestampCell_(cell)
            : snsHistoryNumberCell_(cell);
      });
      return row;
    })
    // Rows without a timestamp (leftovers of a partial write, say)
    // cannot be placed on a time axis; drop them.
    .filter((row) => row.collected_at !== null)
    .sort((a, b) =>
      a.collected_at < b.collected_at ? -1 : a.collected_at > b.collected_at ? 1 : 0
    );
  const downsampled = downsampleSnsHistoryRows_(
    rows.slice(-SNS_HISTORY_MAX_ROWS)
  );
  const response = {
    ok: true,
    action: 'sns_history',
    rows: downsampled.rows,
  };
  // The flag is present only when rows were actually
  // collapsed, so a short history answers exactly as before.
  if (downsampled.downsampled) {
    response.history_downsampled = true;
  }
  return response;
}


export { SNS_HISTORY_HOURLY_WINDOW_MS, SNS_HISTORY_RESPONSE_COLUMNS, assembleSnsHistoryResponse_, buildSnsHistoryResponse_, downsampleSnsHistoryRows_, snsHistoryNumberCell_, snsHistoryTimestampCell_ };
