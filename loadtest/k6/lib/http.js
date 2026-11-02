// Authenticated JSON calls with consistent tagging. Every request carries `journey` (browse, transfers, ...) and
// `name` (the route template, e.g. "GET /transactions/accounts/:id/balance"), so ids never explode the metric
// series and thresholds can be set per journey. A response counts as failed in http_req_failed unless its status
// is one the caller expects.
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL } from './config.js';
import { accessToken, dropSession } from './session.js';

/** 429s by journey: a single load generator hits per-IP limits long before the services saturate */
export const rateLimited = new Counter('rate_limited');
export const serverErrors = new Counter('server_errors');
/** Expected business refusals (insufficient funds, daily caps): test-data problems, not service failures */
export const businessRejections = new Counter('business_rejections');
/** Wall time of one complete journey (one page view, one transfer, one top-up ...) */
export const journeyDuration = new Trend('journey_duration', true);

function params(token, { journey, name, headers = {}, expected = [200], timeout, json = true }) {
  return {
    headers: {
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    tags: { journey, name },
    responseCallback: http.expectedStatuses(...expected),
    ...(timeout ? { timeout } : {}),
  };
}

function record(res, options) {
  const { journey, name, expected = [200] } = options;
  if (res.status === 429) rateLimited.add(1, { journey });
  if (res.status >= 500) serverErrors.add(1, { journey, name });
  check(res, { [`${name}: ${expected.join('|')}`]: (r) => expected.includes(r.status) }, { journey });
  return res;
}

/**
 * One authenticated request. On a 401 the session is dropped and the request repeated once with a fresh
 * sign-in (an access token can be revoked or expire between the refresh check and the call).
 * Returns null when the user cannot sign in at all.
 */
export function api(method, path, options) {
  const send = () => {
    const token = accessToken();
    if (!token) return null;
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    return http.request(method, `${BASE_URL}${path}`, body, params(token, { ...options, json: options.body !== undefined }));
  };
  let res = send();
  if (res && res.status === 401) {
    dropSession();
    res = send();
  }
  return res ? record(res, options) : null;
}

/** Parallel GETs, the way a page loads its widgets: [[path, name], ...] */
export function getAll(requests, options) {
  const send = () => {
    const token = accessToken();
    if (!token) return null;
    return http.batch(
      requests.map(([path, name]) => ['GET', `${BASE_URL}${path}`, null, params(token, { ...options, name, json: false })])
    );
  };
  let responses = send();
  if (responses && responses.some((r) => r.status === 401)) {
    dropSession();
    responses = send();
  }
  if (!responses) return null;
  return responses.map((res, i) => record(res, { ...options, name: requests[i][1] }));
}

/** The response's JSON `data`, or undefined for an error or a non-JSON body */
export function dataOf(res) {
  if (!res || res.status < 200 || res.status >= 300) return undefined;
  try {
    return res.json('data');
  } catch {
    return undefined;
  }
}

export function errorCode(res) {
  try {
    return res?.json('error.code') ?? String(res?.status ?? 0);
  } catch {
    return String(res?.status ?? 0);
  }
}
