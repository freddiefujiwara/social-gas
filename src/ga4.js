// GA4 report plumbing from the original ga4-gas bridge: report
// parameters, request building, and the JSON / HTML output helpers.

import { GA4_API_BASE } from './publicActions.js';

const DEFAULT_START = '28daysAgo';
const DEFAULT_END = 'today';
const DEFAULT_METRICS = 'screenPageViews,activeUsers,sessions';
const DEFAULT_DIMENSIONS = 'pagePath';
const DEFAULT_LIMIT = 25;

function parseListParam_(value, fallback) {
  const raw = value == null ? fallback : value;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s);
}

const MATCH_TYPES = {
  exact: 'EXACT',
  contains: 'CONTAINS',
  beginsWith: 'BEGINS_WITH',
  endsWith: 'ENDS_WITH',
  regexp: 'FULL_REGEXP',
};

function parseFilterClauses_(value) {
  if (value == null || value === '') {
    return [];
  }
  return String(value)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s)
    .map((clause) => {
      const first = clause.indexOf(':');
      const second = clause.indexOf(':', first + 1);
      if (first < 1 || second < 0) {
        throw new Error(
          'Invalid filter clause (expected <dimension>:<matchType>:<value>): ' + clause
        );
      }
      const fieldName = clause.slice(0, first).trim();
      const matchType = MATCH_TYPES[clause.slice(first + 1, second).trim()];
      const filterValue = clause.slice(second + 1);
      if (!fieldName || !matchType || filterValue === '') {
        throw new Error(
          'Invalid filter clause (expected <dimension>:<matchType>:<value>): ' + clause
        );
      }
      return { fieldName, matchType, value: filterValue };
    });
}

function buildDimensionFilter_(clauses) {
  const expressions = clauses.map((c) => ({
    filter: {
      fieldName: c.fieldName,
      stringFilter: { matchType: c.matchType, value: c.value, caseSensitive: false },
    },
  }));
  if (expressions.length === 1) {
    return expressions[0];
  }
  return { andGroup: { expressions } };
}

function parseRunParams_(parameter) {
  const p = parameter || {};
  const limit = Number(p.limit);
  const offset = Number(p.offset);
  return {
    startDate: p.start || DEFAULT_START,
    endDate: p.end || DEFAULT_END,
    metrics: parseListParam_(p.metrics, DEFAULT_METRICS),
    dimensions: parseListParam_(
      p.dimensions == null ? DEFAULT_DIMENSIONS : p.dimensions,
      DEFAULT_DIMENSIONS
    ),
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT,
    offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
    filters: parseFilterClauses_(p.filter),
  };
}

function buildReportRequest_(params) {
  const body = {
    dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
    metrics: params.metrics.map((name) => ({ name })),
    dimensions: params.dimensions.map((name) => ({ name })),
    limit: String(params.limit),
    offset: String(params.offset || 0),
  };
  if (params.filters && params.filters.length > 0) {
    body.dimensionFilter = buildDimensionFilter_(params.filters);
  }
  if (params.dimensions.length > 0 && params.metrics.length > 0) {
    body.orderBys = [{ metric: { metricName: params.metrics[0] }, desc: true }];
  }
  return body;
}

function fetchReport_(propertyId, body) {
  const res = UrlFetchApp.fetch(GA4_API_BASE + propertyId + ':runReport', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  return { status: res.getResponseCode(), data: JSON.parse(res.getContentText()) };
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function htmlOut_(html) {
  return ContentService.createTextOutput(html).setMimeType(
    ContentService.MimeType.HTML
  );
}


export { buildDimensionFilter_, buildReportRequest_, fetchReport_, htmlOut_, jsonOut_, parseFilterClauses_, parseListParam_, parseRunParams_ };
