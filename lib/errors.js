// Shared error envelope for all route responses.
//
// Shape: { error: string, code?: string, detail?: any }
//   error  — human-readable message; always present
//   code   — short machine-readable code (ErrorCodes) for client branching
//   detail — optional structured context (upstream body, hint, etc.)
//
// Status code conventions:
//   400  BAD_INPUT         malformed body / params
//   401  AUTH_FAILED       bad or missing sync key
//   404  NOT_FOUND         unknown resource (e.g. team abbr)
//   502  UPSTREAM_FAILED   upstream API unreachable or returned non-success
//   502  UPSTREAM_HTML     upstream returned an HTML error page where data was expected
//   503  NOT_CONFIGURED    server is missing required env (API key, VAPID, DATABASE_URL)
//   500  INTERNAL          uncaught exception in handler

const ErrorCodes = {
  NOT_CONFIGURED:  'NOT_CONFIGURED',
  BAD_INPUT:       'BAD_INPUT',
  AUTH_FAILED:     'AUTH_FAILED',
  NOT_FOUND:       'NOT_FOUND',
  UPSTREAM_FAILED: 'UPSTREAM_FAILED',
  UPSTREAM_HTML:   'UPSTREAM_HTML',
  INTERNAL:        'INTERNAL',
};

function errorResponse(res, status, error, opts = {}) {
  const body = { error };
  if (opts.code) body.code = opts.code;
  if (opts.detail !== undefined) body.detail = opts.detail;
  return res.status(status).json(body);
}

module.exports = { errorResponse, ErrorCodes };
