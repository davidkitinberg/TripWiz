'use strict';

// [Review #3] Shared HTTP helpers for API Gateway proxy responses.
// Previously these were re-implemented in every REST-facing Lambda; centralising
// them keeps the response envelope and CORS headers identical across handlers.

const corsHeaders = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,DELETE'
});

const ok = (statusCode, body) => ({
  statusCode,
  headers: corsHeaders(),
  body: body === undefined ? '' : JSON.stringify(body)
});

const noContent = () => ({ statusCode: 204, headers: corsHeaders(), body: '' });

const fail = (statusCode, code, message, details) =>
  ok(statusCode, { error: { code, message, ...(details ? { details } : {}) } });

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch (err) {
    const e = new Error('Request body must be valid JSON');
    e.statusCode = 400;
    e.code = 'INVALID_JSON';
    throw e;
  }
}

module.exports = { corsHeaders, ok, noContent, fail, parseBody };
